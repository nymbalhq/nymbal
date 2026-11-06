import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { defineCommand } from 'citty'
import pc from 'picocolors'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  createApp,
  createCommandStore,
  createLocalFsMediaStorage,
  createLogger,
  newCorrelationId,
  runAsActor,
  runMigrations,
  runWithCorrelation,
  type NymbalApp,
} from '@nymbalhq/platform'
import { createHttpServer, type HttpServer } from '@nymbalhq/http'
import {
  buildRedirects,
  currencyRefusal,
  diffProduct,
  DIFF_FIELDS,
  lighthousePairs,
  lighthouseSection,
  loadState,
  planWooCommerceImport,
  runWooCommerceImport,
  WooCommerceApiError,
  WooCommerceClient,
  writePreview,
  type DiffField,
  type ImportEntity,
  type ImportPlan,
  type ImportReport,
  type ImportState,
  type PreviewReport,
  type ProductDiff,
  type ProgressEvent,
  type ServedProduct,
  type WooCommerceCredentials,
} from '@nymbalhq/importers'
import { loadProject } from '../utils/project.js'
import { isPortFree } from '../utils/port.js'
import { planTemplateLaunch, type TemplateLaunch } from '../utils/template-runner.js'
import { runShutdown } from '../utils/shutdown.js'
import { getCliVersion } from '../utils/version.js'
import { defaultStorefrontPort, storefrontEnv } from './dev.js'
import { resolveMigrations } from './migrate.js'
import { previewConfig } from './preview-config.js'
import {
  buildPreviewStorefront,
  checkChrome,
  measurePairs,
  planPreviewStorefront,
  resolveLighthouse,
  scoreLines,
  startPreviewStorefront,
  stopLighthouse,
  type PreviewStorefront,
} from './preview-lighthouse.js'

type Rec = Record<string, unknown>

const ENTITIES = [
  'categories',
  'products',
  'customers',
  'orders',
  'reviews',
] as const satisfies readonly ImportEntity[]
const DEFAULT_ENTITIES: ImportEntity[] = ['categories', 'products', 'customers', 'orders']
/** Next.js builds beside the project's own `.next`, so a preview never overwrites the build `nymbal dev` serves. */
const NEXT_DIST_DIR = '.next-preview'
/** What `next dev` rewrites for its dist dir; put back as they were when the preview stops. */
const NEXT_REWRITES = ['next-env.d.ts', 'tsconfig.json', 'tsconfig.dist.json']
/** Long enough for a dev server's process group to exit and the directory to go. */
const STOP_BOUND_MS = 15_000
const STOREFRONT_WAIT_MS = 180_000
const MEDIA_PATH = '/preview-media'

const MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.avif', 'image/avif'],
])

/** A preview that cannot go on: its message is printed and it stops with exit 1. */
class PreviewError extends Error {}

function printProgress(event: ProgressEvent): void {
  if (event.kind === 'phase') {
    process.stdout.write(`${pc.cyan(`  → ${event.phase}`)}\n`)
  } else if (event.kind === 'progress') {
    const pct = event.total === 0 ? 100 : Math.round((event.done / event.total) * 100)
    process.stdout.write(`\r  ${event.entity}: ${event.done}/${event.total} (${pct}%)  `)
    if (event.done >= event.total) process.stdout.write('\n')
  } else if (event.kind === 'error') {
    process.stdout.write(`${pc.red(`  ✗ ${event.phase} [${event.id}]: ${event.message}`)}\n`)
  }
}

function integerArg(
  flag: string,
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new PreviewError(`${flag} must be an integer from ${min} to ${max}, got "${raw}"`)
  }
  return n
}

function portArg(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PreviewError(`${flag} must be an integer from 1 to 65535, got "${raw}"`)
  }
  return port
}

/** Whether something accepts connections on `host:port`. */
function answers(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host })
    const end = (result: boolean) => {
      socket.destroy()
      done(result)
    }
    socket.setTimeout(500, () => end(false))
    socket.once('connect', () => end(true))
    socket.once('error', () => end(false))
  })
}

/**
 * The first port from `preferred` up that is free and not `taken`. A bind probe alone can succeed beside a server
 * holding the port on one loopback address (BSD's SO_REUSEADDR), so a port anything answers on is busy too.
 */
async function freePortFrom(preferred: number, taken: number[] = []): Promise<number> {
  for (let candidate = preferred; candidate <= Math.min(preferred + 19, 65535); candidate++) {
    if (taken.includes(candidate)) continue
    if (!(await isPortFree(candidate))) continue
    if ((await answers(candidate, '127.0.0.1')) || (await answers(candidate, '::1'))) continue
    return candidate
  }
  throw new PreviewError(
    `No free port from ${preferred} to ${preferred + 19}: pass a free one with --port or --storefront-port`,
  )
}

/** `GET /preview-media/*`: the images the import downloaded into the preview's directory, and nothing outside it. */
function mediaRoute(root: string) {
  let base: Promise<string> | null = null
  return async (path: string) => {
    base ??= realpath(root)
    const real = await base
    const candidate = resolve(real, `.${sep}${path}`)
    const notFound = { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found\n' }
    if (path.includes('\0') || !candidate.startsWith(real + sep)) return notFound
    try {
      const file = await realpath(candidate)
      if (!file.startsWith(real + sep) || !(await stat(file)).isFile()) return notFound
      return {
        status: 200,
        headers: {
          'Content-Type': MIME.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
        body: await readFile(file),
      }
    } catch {
      return notFound
    }
  }
}

async function getData<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new PreviewError(`The preview's API answered ${res.status} to ${url}`)
  return ((await res.json()) as { data: T }).data
}

/** Every product document the preview's API serves, over all its pages. */
async function servedProducts(apiUrl: string): Promise<Array<ServedProduct & { slug: string }>> {
  const all: Array<ServedProduct & { slug: string }> = []
  let cursor: string | null = null
  do {
    const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
    const page: { items: Array<ServedProduct & { slug: string }>; nextCursor: string | null } =
      await getData(`${apiUrl}/api/products?limit=100${query}`)
    all.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== null)
  return all
}

/**
 * Answers once the storefront answers anything, or throws when it cannot start, exits or never answers. Called as soon
 * as the child is spawned, so its `error` event (a launcher that cannot be run) has a listener.
 */
async function storefrontUp(url: string, child: ChildProcess): Promise<void> {
  const launch: { error?: Error } = {}
  child.once('error', (err) => {
    launch.error = err
  })
  const deadline = Date.now() + STOREFRONT_WAIT_MS
  while (Date.now() < deadline) {
    if (launch.error !== undefined) {
      throw new PreviewError(`The storefront dev server could not start: ${launch.error.message}`)
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new PreviewError(
        `The storefront dev server exited (${child.exitCode ?? child.signalCode}) before it answered`,
      )
    }
    try {
      await fetch(url, { signal: AbortSignal.timeout(30_000) })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new PreviewError(
    `The storefront at ${url} did not answer within ${STOREFRONT_WAIT_MS / 1000} s`,
  )
}

interface Collected {
  categories: Rec[]
  products: Rec[]
  variations: Map<number, Rec[]>
  reviews: Rec[]
}

interface ReportInput {
  config: NymbalConfig
  app: NymbalApp
  apiUrl: string
  entities: ImportEntity[]
  plan: ImportPlan
  report: ImportReport
  state: ImportState
  source: Collected
}

/** The preview's report and redirect map, from the plan, the import and what the preview's own API serves. */
async function buildPreview({
  config,
  app,
  apiUrl,
  entities,
  plan,
  report,
  state,
  source,
}: ReportInput) {
  const served = await servedProducts(apiUrl)
  const servedBySlug = new Map(served.map((p) => [p.slug, p]))
  const categories = await getData<unknown[]>(`${apiUrl}/api/categories`)

  const productsById = new Map(source.products.map((p) => [Number(p['id']), p]))
  const categoriesById = new Map(source.categories.map((c) => [Number(c['id']), c]))
  const byWcId = (map: Record<string, string>) =>
    Object.entries(map)
      .map(([wcId, id]) => [Number(wcId), id] as const)
      .sort((a, b) => a[0] - b[0])

  const imported: Array<{ wcId: number; slug: string; name: string; listed: boolean }> = []
  for (const [wcId, id] of byWcId(state.wcToNymbalProduct)) {
    const product = await app.services.product.getById(id)
    imported.push({
      wcId,
      slug: product.slug,
      name: product.name,
      listed: servedBySlug.has(product.slug),
    })
  }

  const byField = Object.fromEntries(DIFF_FIELDS.map((f) => [f, 0])) as Record<DiffField, number>
  const differences: ProductDiff[] = []
  for (const p of imported.filter((x) => x.listed)) {
    const product = productsById.get(p.wcId)
    if (product === undefined) continue
    const changes = diffProduct(
      { product, variations: source.variations.get(p.wcId) ?? [] },
      servedBySlug.get(p.slug)!,
      config.store.currency,
    )
    if (changes.length === 0) continue
    for (const c of changes) byField[c.field]++
    differences.push({ wcId: p.wcId, slug: p.slug, name: p.name, changes })
  }

  const redirectCategories: Array<{ source: Rec; nymbalSlug: string }> = []
  for (const [wcId, id] of byWcId(state.wcToNymbalCategory)) {
    const category = categoriesById.get(wcId)
    if (category === undefined) continue
    redirectCategories.push({
      source: category,
      nymbalSlug: (await app.services.category.getById(id)).slug,
    })
  }
  const redirects = buildRedirects({
    sourceCategories: source.categories,
    categories: redirectCategories,
    products: imported.flatMap((p) => {
      const product = productsById.get(p.wcId)
      return product === undefined
        ? []
        : [{ source: product, nymbalSlug: p.slug, listed: p.listed }]
    }),
  })
  const errorOf = (phase: string, wcId: number) =>
    state.errors.find((e) => e.phase === phase && e.id === String(wcId))?.error ?? 'not imported'
  const refused = [
    ...source.categories
      .filter((c) => state.wcToNymbalCategory[String(c['id'])] === undefined)
      .map((c) => ({
        kind: 'category' as const,
        wcId: Number(c['id']),
        reason: `refused: ${errorOf('categories', Number(c['id']))}`,
      })),
    ...source.products
      .filter((p) => state.wcToNymbalProduct[String(p['id'])] === undefined)
      .map((p) => ({
        kind: 'product' as const,
        wcId: Number(p['id']),
        reason: `refused: ${errorOf('products', Number(p['id']))}`,
      })),
  ]

  const refusedOf = (e: ImportEntity) =>
    new Set(report.errors.filter((x) => x.phase === e).map((x) => x.id ?? x.error)).size
  const skippedReviews = source.reviews.filter(
    (r) => state.wcToNymbalProduct[String(r['product_id'])] === undefined,
  ).length
  const counts = Object.fromEntries(
    ENTITIES.map((e) => [
      e,
      {
        source: plan.counts[e].source,
        planned: plan.counts[e].import,
        imported: report.imported[e],
        refused: refusedOf(e),
        skipped: e === 'reviews' ? skippedReviews : 0,
        served: e === 'products' ? served.length : e === 'categories' ? categories.length : null,
      },
    ]),
  ) as PreviewReport['counts']

  const preview: PreviewReport = {
    source: plan.source,
    generatedAt: new Date().toISOString(),
    currency: config.store.currency,
    entities,
    counts,
    errors: report.errors,
    warnings: report.warnings,
    unmapped: plan.unmapped,
    notListed: imported
      .filter((p) => !p.listed)
      .map(({ wcId, slug, name }) => ({ wcId, slug, name })),
    differences: { byField, products: differences },
    redirects: {
      rows: redirects.rows.length,
      unredirected: [...redirects.unredirected, ...refused],
      duplicates: redirects.duplicates,
    },
    lighthouse: null,
  }
  return { preview, rows: redirects.rows }
}

interface PreviewArgs {
  source?: string
  url?: string
  key?: string
  secret?: string
  entities?: string
  gdpr: boolean
  ai: boolean
  concurrency?: string
  'untracked-stock'?: string
  keep: boolean
  apiOnly: boolean
  port?: string
  storefrontPort?: string
  lighthouse: boolean
  'lighthouse-runs'?: string
  'lighthouse-timeout'?: string
}

interface LighthousePlan {
  cli: string
  runs: number
  timeoutMs: number
  storefront: PreviewStorefront
}

/** `--lighthouse`'s refusals, all before the source is read: its flags, Lighthouse, Chrome and the build's tools. */
async function lighthousePlan(
  args: PreviewArgs,
  projectRoot: string,
  template: NymbalConfig['template'],
): Promise<LighthousePlan> {
  if (args.apiOnly) {
    throw new PreviewError(
      '--lighthouse measures the storefront: it cannot be used with --api-only',
    )
  }
  const runs = integerArg('--lighthouse-runs', args['lighthouse-runs'], 1, 9, 3)
  const timeout = integerArg('--lighthouse-timeout', args['lighthouse-timeout'], 10, 600, 120)
  const lighthouse = resolveLighthouse(projectRoot, process.env)
  if ('error' in lighthouse) throw new PreviewError(lighthouse.error)
  const chrome = await checkChrome(lighthouse, process.env)
  if (chrome !== null) throw new PreviewError(chrome)
  const storefront = planPreviewStorefront(projectRoot, template, process.env)
  if ('error' in storefront) throw new PreviewError(storefront.error)
  return { cli: lighthouse.cli, runs, timeoutMs: timeout * 1000, storefront }
}

function credentialsOf(args: PreviewArgs): WooCommerceCredentials {
  if (args.source !== 'woocommerce') {
    throw new PreviewError(
      args.source === undefined
        ? '--source is required (woocommerce)'
        : `Unsupported source: ${args.source}. Only 'woocommerce' is supported.`,
    )
  }
  if (!args.url)
    throw new PreviewError('--url is required (the WooCommerce store, e.g. https://mystore.com)')
  const consumerKey = args.key ?? process.env['WOOCOMMERCE_KEY'] ?? ''
  if (!consumerKey) throw new PreviewError('--key or WOOCOMMERCE_KEY is required')
  const consumerSecret = args.secret ?? process.env['WOOCOMMERCE_SECRET'] ?? ''
  if (!consumerSecret) throw new PreviewError('--secret or WOOCOMMERCE_SECRET is required')
  return { url: args.url, consumerKey, consumerSecret }
}

function entitiesOf(raw: string | undefined): ImportEntity[] {
  if (!raw) return DEFAULT_ENTITIES
  const names = raw.split(',').map((e) => e.trim())
  const unknown = names.filter((e) => !(ENTITIES as readonly string[]).includes(e))
  if (unknown.length > 0) {
    throw new PreviewError(
      `Unknown entity: ${unknown.join(', ')}. Choose from ${ENTITIES.join(', ')}.`,
    )
  }
  return names as ImportEntity[]
}

/** Connects to the source and refuses a store in another currency, with the import's own message, before any read. */
async function checkSource(credentials: WooCommerceCredentials, currency: string): Promise<void> {
  const client = new WooCommerceClient(credentials)
  try {
    await client.healthCheck()
  } catch (err) {
    if (err instanceof WooCommerceApiError) throw err
    throw new Error(`Cannot connect to ${credentials.url}: ${String(err)}`)
  }
  const settings = await client.getStoreSettings()
  if (settings !== null && settings.currency.toUpperCase() !== currency.toUpperCase()) {
    throw new PreviewError(currencyRefusal(settings.currency, currency))
  }
}

/** What the preview has started, in the order it stops them. */
interface Running {
  dir?: string
  app?: NymbalApp
  http?: HttpServer
  storefront?: ChildProcess
  /** The production build under --lighthouse, while it runs. */
  build?: ChildProcess
  /** The Lighthouse run under way. */
  lighthouse?: ChildProcess | null
  /** The project files `next dev` rewrites, as they were: null for one that did not exist. */
  nextFiles?: Map<string, Buffer | null>
  nextDistDir?: string
}

async function stopStorefront(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  // Its own process group: the framework's workers go with it.
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, s)
    } catch {
      // the group is gone
    }
  }
  signal('SIGTERM')
  const timer = setTimeout(() => signal('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
  signal('SIGKILL')
}

async function runPreview(args: PreviewArgs): Promise<void> {
  const running: Running = {}
  let stopping = false
  const quiet = { info: () => undefined, error: (_: unknown, msg?: string) => console.error(msg) }
  const stop = (code: 0 | 1): Promise<never> => {
    stopping = true
    return runShutdown(
      [
        {
          name: 'lighthouse.stop',
          run: async () => {
            if (running.lighthouse) await stopLighthouse(running.lighthouse)
          },
        },
        {
          name: 'build.stop',
          run: async () => {
            if (running.build !== undefined) await stopStorefront(running.build)
          },
        },
        {
          name: 'storefront.stop',
          run: async () => {
            if (running.storefront !== undefined) await stopStorefront(running.storefront)
          },
        },
        { name: 'http.stop', run: async () => running.http?.stop() },
        { name: 'app.stop', run: async () => running.app?.stop() },
        {
          name: 'storefront.files',
          run: async () => {
            if (running.nextFiles === undefined) return
            for (const [path, bytes] of running.nextFiles) {
              const now = existsSync(path) ? await readFile(path) : null
              if (bytes === null) await rm(path, { force: true })
              else if (now === null || !now.equals(bytes)) await writeFile(path, bytes)
            }
          },
        },
        {
          name: 'dir.remove',
          run: async () => {
            if (running.nextDistDir !== undefined) {
              await rm(running.nextDistDir, {
                recursive: true,
                force: true,
                maxRetries: 3,
              })
            }
            if (running.dir !== undefined && !args.keep) {
              await rm(running.dir, { recursive: true, force: true, maxRetries: 3 })
            }
          },
        },
      ],
      { boundMs: STOP_BOUND_MS, logger: quiet, exit: (c) => process.exit(code === 1 ? 1 : c) },
    )
  }

  try {
    const credentials = credentialsOf(args)
    const entities = entitiesOf(args.entities)
    const loaded = await loadProject()
    const { projectRoot } = loaded
    const config = loaded.config
    const lighthouse = args.lighthouse
      ? await lighthousePlan(args, projectRoot, config.template)
      : null

    // ── 1. Ports, and 2. the storefront's launch, before anything is read ─────────────────────────────────────────
    const apiPort = await freePortFrom(portArg('--port', args.port) ?? config.http.port)
    let storefrontPort: number | null = null
    let launch: TemplateLaunch | null = null
    if (!args.apiOnly) {
      const preferred =
        portArg('--storefront-port', args.storefrontPort) ?? defaultStorefrontPort(config.template)
      storefrontPort = await freePortFrom(preferred, [apiPort])
      if (lighthouse === null)
        launch = planTemplateLaunch(projectRoot, config.template, storefrontPort)
    }
    const apiUrl = `http://127.0.0.1:${apiPort}`
    const storefrontOrigin = storefrontPort === null ? null : `http://localhost:${storefrontPort}`
    // The production storefront binds 127.0.0.1 only, so Chrome is never sent to localhost's ::1.
    const storefrontUrl =
      lighthouse !== null && storefrontPort !== null
        ? `http://127.0.0.1:${storefrontPort}`
        : storefrontOrigin

    await checkSource(credentials, config.store.currency)

    // A repeated Ctrl-C waits for the stop under way (bounded by STOP_BOUND_MS): ending at once would skip the cleanup.
    const onSignal = () => {
      if (!stopping) void stop(0)
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)

    // ── 3. The preview's own directory, store and app ──────────────────────────────────────────────────────────
    const dir = await mkdtemp(join(tmpdir(), 'nymbal-preview-'))
    running.dir = dir
    const sqlitePath = join(dir, 'preview.db')
    const mediaRoot = join(dir, 'media')
    const statePath = join(dir, '.nymbal-migration.json')
    const preview = previewConfig(config, {
      dir,
      apiPort,
      storefrontOrigin,
      ai: args.ai,
    })

    const store = createCommandStore(preview, { sqlitePath })
    try {
      await runMigrations(store, { migrationsRoot: resolveMigrations(projectRoot) })
    } finally {
      await store.close()
    }
    const version = getCliVersion()
    const logger = createLogger({
      base: { store: config.store.name },
      level: process.env['LOG_LEVEL'] || 'warn',
    })
    const app = await createApp(preview, { version, logger, sqlitePath, mediaRoot })
    running.app = app

    // ── 4. The plan, then the import, both through the importer's own code ──────────────────────────────────────
    const source: Collected = { categories: [], products: [], variations: new Map(), reviews: [] }
    const concurrency = parseInt(args.concurrency ?? '4', 10)
    const plan = await planWooCommerceImport(
      { credentials, entities, gdpr: args.gdpr, currency: config.store.currency, concurrency },
      {
        existing: null,
        onProgress: printProgress,
        onRecord: (entity, record, parentWcId) => {
          if (entity === 'categories') source.categories.push(record)
          else if (entity === 'products') source.products.push(record)
          else if (entity === 'reviews') source.reviews.push(record)
          else if (entity === 'variations' && parentWcId !== undefined) {
            source.variations.set(parentWcId, [
              ...(source.variations.get(parentWcId) ?? []),
              record,
            ])
          }
        },
      },
    )
    const report = await runWithCorrelation(newCorrelationId('import:woocommerce'), () =>
      runAsActor({ kind: 'import', id: 'woocommerce' }, () =>
        runWooCommerceImport(
          {
            credentials,
            entities,
            ai: args.ai,
            gdpr: args.gdpr,
            fresh: false,
            concurrency,
            projectRoot: dir,
            currency: config.store.currency,
            statePath,
            ...(args['untracked-stock'] !== undefined && {
              untrackedStock: Number(args['untracked-stock']),
            }),
          },
          {
            services: app.services,
            repos: app.repos,
            adapters: { ai: app.adapters.ai, reviews: app.adapters.reviews },
            media: createLocalFsMediaStorage({
              root: mediaRoot,
              urlPrefix: `${apiUrl}${MEDIA_PATH}`,
            }),
            onProgress: printProgress,
          },
        ),
      ),
    )
    const state = await loadState(statePath)
    if (state === null) throw new PreviewError(`The import left no state at ${statePath}`)

    // ── 5. The API: the store's routes and its images, no admin and no MCP ──────────────────────────────────────
    await app.relay.drain()
    const http = createHttpServer({
      config: preview,
      logger,
      documentStore: app.platform.documentStore,
      version,
      network: app.network,
    })
    await app.attachHttp(http.adapter, { adminRoot: null })
    const media = mediaRoute(mediaRoot)
    http.registerRoute('GET', `${MEDIA_PATH}/*`, (ctx) => media(ctx.params['*'] ?? ''))
    running.http = http
    await http.start()

    // ── 6. The report and the redirect map ─────────────────────────────────────────────────────────────────────
    const built = await buildPreview({ config, app, apiUrl, entities, plan, report, state, source })
    const paths = await writePreview(built.preview, built.rows, projectRoot, config.store.name)

    // ── 7. The project's own storefront on the preview's API ───────────────────────────────────────────────────
    if (stopping) return
    if (launch !== null && storefrontPort !== null && storefrontUrl !== null) {
      const env = storefrontEnv(preview, apiUrl, storefrontPort)
      if (config.template === 'nextjs') {
        const files = new Map<string, Buffer | null>()
        for (const name of NEXT_REWRITES) {
          const path = join(projectRoot, name)
          files.set(path, existsSync(path) ? await readFile(path) : null)
        }
        running.nextFiles = files
        running.nextDistDir = join(projectRoot, NEXT_DIST_DIR)
        env['NYMBAL_NEXT_DIST_DIR'] = NEXT_DIST_DIR
      }
      running.storefront = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env,
        stdio: 'inherit',
        detached: true,
      })
      await storefrontUp(storefrontUrl, running.storefront)
    }

    // ── 7 with --lighthouse: a production build of the storefront, then Lighthouse on both sides ───────────────
    if (lighthouse !== null && storefrontPort !== null && storefrontUrl !== null) {
      const storefront = lighthouse.storefront
      const env: NodeJS.ProcessEnv = {
        ...storefrontEnv(preview, apiUrl, storefrontPort),
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(storefrontPort),
      }
      if (storefront.template === 'nextjs' && storefront.bin !== null) {
        const files = new Map<string, Buffer | null>()
        for (const name of NEXT_REWRITES) {
          const path = join(storefront.cwd, name)
          files.set(path, existsSync(path) ? await readFile(path) : null)
        }
        running.nextFiles = files
        running.nextDistDir = join(storefront.cwd, NEXT_DIST_DIR)
        env['NYMBAL_NEXT_DIST_DIR'] = NEXT_DIST_DIR
      }
      if (storefront.bin !== null) {
        process.stdout.write('storefront: building for production\n')
        await buildPreviewStorefront(storefront, {
          dir,
          env,
          onChild: (child) => (running.build = child),
          stopped: () => stopping,
        })
      }
      if (stopping) return
      running.storefront = startPreviewStorefront(storefront, { dir, port: storefrontPort, env })
      await storefrontUp(storefrontUrl, running.storefront)

      const pairs = await measurePairs(
        lighthousePairs({
          sourceUrl: credentials.url,
          storefrontOrigin: storefrontUrl,
          rows: built.rows,
        }),
        {
          cli: lighthouse.cli,
          runs: lighthouse.runs,
          timeoutMs: lighthouse.timeoutMs,
          dir,
          stopped: () => stopping,
          onChild: (child) => (running.lighthouse = child),
        },
      )
      if (stopping) return
      await writePreview(
        { ...built.preview, lighthouse: lighthouseSection(lighthouse.runs, pairs) },
        built.rows,
        projectRoot,
        config.store.name,
      )
      process.stdout.write(`${scoreLines(pairs).join('\n')}\n`)
    }

    process.stdout.write(
      `${[
        '',
        pc.green('Preview ready'),
        `  API:        ${apiUrl}`,
        `  Storefront: ${storefrontUrl ?? 'api only'}`,
        `  Report:     ${paths.markdown}`,
        `              ${paths.json}`,
        `  Redirects:  ${paths.csv}`,
        ...(args.keep ? [`  Kept:       ${dir}`] : []),
        '',
        `Your store is unchanged. Press Ctrl-C to stop${args.keep ? '' : ' and delete the preview'}.`,
      ].join('\n')}\n`,
    )
  } catch (err) {
    if (stopping) return
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${pc.red(message)}\n`)
    await stop(1)
  }
}

export const previewCommand = defineCommand({
  meta: {
    name: 'preview',
    description:
      'Import a WooCommerce store into a throwaway store and serve it on your storefront, with a report and a redirect map; your own store is not touched',
  },
  args: {
    source: { type: 'string', description: 'Import source (woocommerce)' },
    url: { type: 'string', description: 'Store URL (e.g. https://mystore.com)' },
    key: { type: 'string', description: 'WooCommerce Consumer Key (or set WOOCOMMERCE_KEY)' },
    secret: {
      type: 'string',
      description: 'WooCommerce Consumer Secret (or set WOOCOMMERCE_SECRET)',
    },
    entities: {
      type: 'string',
      description:
        'Comma-separated list: categories,products,customers,orders,reviews (default: categories,products,customers,orders)',
    },
    gdpr: { type: 'boolean', description: 'Anonymise customer PII (default: true)', default: true },
    ai: {
      type: 'boolean',
      description: "Enrich products with the project's ai provider (default: false)",
      default: false,
    },
    concurrency: { type: 'string', description: 'Parallel import workers (default: 4)' },
    'untracked-stock': {
      type: 'string',
      description:
        'Stock for products WooCommerce does not count, when in stock or on backorder (default: 1000)',
    },
    keep: {
      type: 'boolean',
      description:
        'Keep the preview directory (its store, media and import state) when the preview stops',
      default: false,
    },
    apiOnly: {
      type: 'boolean',
      // citty registers the camelCase key; the alias maps the kebab flag onto it (see `nymbal dev`).
      alias: 'api-only',
      description: 'Serve only the API (no storefront)',
      default: false,
    },
    port: {
      type: 'string',
      description:
        "Port for the preview's API (default: the config's http.port, or the next free one)",
    },
    storefrontPort: {
      type: 'string',
      alias: 'storefront-port',
      description:
        'Port for the storefront (default: 4321 Astro / 3000 Next.js, or the next free one)',
    },
    lighthouse: {
      type: 'boolean',
      description:
        "Build the storefront for production and compare Lighthouse scores of the store's home, a product and a category with the preview's (needs lighthouse@^12 and Chrome)",
      default: false,
    },
    'lighthouse-runs': {
      type: 'string',
      description: 'Lighthouse runs per page, 1 to 9; the report shows the median (default: 3)',
    },
    'lighthouse-timeout': {
      type: 'string',
      description: 'Seconds one Lighthouse run may take, 10 to 600 (default: 120)',
    },
  },
  async run({ args }) {
    await runPreview(args as PreviewArgs)
  },
})
