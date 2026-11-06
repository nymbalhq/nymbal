import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAiStandIn, type AiStandIn } from '../../../../tests/support/ai-stand-in.js'
import { parseCsv } from '../../../../tests/support/csv.js'
import {
  CLI_BIN,
  cliEnv,
  closedPort,
  freePort,
  linesNaming,
  runCli,
  stripAnsi,
} from '../../../../tests/support/doctor.js'
import { workspace } from '../../../../tests/support/project.js'
import { fakeSmtpServer, type FakeSmtpServer } from '../../../../tests/support/smtp-server.js'
import { storeConfig, storeProject, type StoreProject } from '../../../../tests/support/start.js'
import { readRows } from '../../../../tests/support/store-tables.js'
import {
  fixture,
  startWooCommerceServer,
  type RecordedStoreName,
  type WooCommerceServer,
} from '../../../../tests/support/woocommerce-server.js'
import {
  loadRecordedStore,
  minorUnits,
  currencyDigits,
  type Rec,
  type RecordedStore,
} from '../../../importers/tests/integration/support/recorded-store.js'

// `nymbal preview` through the built CLI (`pnpm build` first), against the WooCommerce fixture server or one of the
// recorded stores it serves. Each run gets a TMPDIR of its own, so the temporary directory the preview makes is the
// one `nymbal-preview-*` entry there; the preview's own store is read from it after a `--keep` run. What the merchant
// is shown is checked against what WooCommerce said, read here from the payloads.

const KEY = 'ck_preview_7d2e9b4a1c3f5086'
const SECRET = 'cs_preview_4b8f1e2a6c9d3075'
const ALL = 'categories,products,customers,orders,reviews'
const ENTITIES = ['categories', 'products', 'customers', 'orders', 'reviews'] as const
type Entity = (typeof ENTITIES)[number]
const OUTPUTS = ['nymbal-preview-report.json', 'nymbal-preview-report.md', 'nymbal-redirects.csv']
const SECTIONS = [
  '## Counts',
  '## Review before launch',
  '## Errors',
  '## Differences',
  '## Not on the storefront',
  '## Redirects',
  '## Unmapped fields',
]
const FIELDS = ['name', 'price', 'variants', 'images', 'categories'] as const
const STATE_MAP: Record<Entity, string> = {
  categories: 'wcToNymbalCategory',
  products: 'wcToNymbalProduct',
  customers: 'wcToNymbalCustomer',
  orders: 'wcToNymbalOrder',
  reviews: 'wcToNymbalReview',
}
/** The recorded answer each entity's source total comes from. */
const TOTAL_FILE: Record<Entity, string> = {
  categories: 'categories.json',
  products: 'products.page-1.json',
  customers: 'customers.json',
  orders: 'orders.json',
  reviews: 'reviews.json',
}

interface Counts {
  source: number
  planned: number
  imported: number
  refused: number
  skipped: number
  served: number | null
}
interface ProductDiff {
  wcId: number
  slug: string
  name: string
  changes: Array<{ field: string; source: string; preview: string }>
}
interface PreviewReport {
  source: { url: string }
  generatedAt: string
  currency: string
  entities: string[]
  counts: Record<Entity, Counts>
  errors: Array<{ phase: string; id?: string; error: string }>
  warnings: Array<{ phase: string; id?: string; message: string }>
  unmapped: Record<string, unknown>
  notListed: Array<{ wcId: number; slug: string; name: string }>
  differences: { byField: Record<string, number>; products: ProductDiff[] }
  redirects: {
    rows: number
    unredirected: Array<{ kind: 'product' | 'category'; wcId: number; reason: string }>
    duplicates: Array<{ from: string; wcIds: number[] }>
  }
  lighthouse?: unknown
}
interface KeptState {
  warnings: Array<{ phase: string; id?: string; message: string }>
  [map: string]: unknown
}

// ─── Running a preview ──────────────────────────────────────────────────────────────────────────────────────────────

interface PreviewRun<T> {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** stdout then stderr, ANSI codes removed. */
  out: string
  /** `Preview ready` was printed, with the API URL after it. */
  ready: boolean
  /** The first URL printed after `Preview ready`. */
  apiUrl: string | null
  /** The TMPDIR the run was given. */
  tmp: string
  /** The `nymbal-preview-*` entries in `tmp` when the signal was sent. */
  dirsWhenSignalled: string[]
  /** The `nymbal-preview-*` entries in `tmp` after the run ended. */
  dirsAfter: string[]
  /** What `whileUp` returned; its error message when it threw. */
  live: T | undefined
  liveError: string | null
  /** How many times the signal was sent. */
  signalsSent: number
}

const PROGRESS_LINE = /\b(?:categories|products|customers|orders|reviews): \d+\/\d+/
const ready = (text: string) => /Preview ready[\s\S]*?(https?:\/\/[^\s'"]+)/.exec(text)
const previewDirs = (tmp: string) =>
  existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith('nymbal-preview-')) : []

/**
 * `nymbal preview <args>` in `cwd` with a TMPDIR of its own. At `Preview ready` (or at the first import progress line,
 * with `at: 'progress'`) it runs `whileUp` against the printed API URL, then sends `signal` and waits for the exit.
 */
async function preview<T = undefined>(
  args: string[],
  opts: {
    cwd: string
    env?: Record<string, string | undefined>
    signal?: NodeJS.Signals
    at?: 'ready' | 'progress'
    whileUp?: (apiUrl: string) => Promise<T>
    /** Sends the signal a second time once the output after the first matches this. */
    again?: RegExp
    timeoutMs?: number
  },
): Promise<PreviewRun<T>> {
  const tmp = mkdtempSync(join(tmpdir(), 'preview-tmpdir-'))
  scratch.push(tmp)
  // A port of its own unless the case names one: config's 3001 is shared by every CLI file running beside this one.
  const port = args.includes('--port') ? [] : ['--port', String(await freePort())]
  const child = spawn(process.execPath, [CLI_BIN, 'preview', ...args, ...port], {
    cwd: opts.cwd,
    env: cliEnv({ TMPDIR: tmp, ...opts.env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let triggered = false
  let dirsWhenSignalled: string[] = []
  let live: T | undefined
  let liveError: string | null = null
  let signalsSent = 0
  let signalledAt = { stdout: 0, stderr: 0 }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  )
  const stop = () => {
    if (signalsSent === 0) {
      dirsWhenSignalled = previewDirs(tmp)
      signalledAt = { stdout: stdout.length, stderr: stderr.length }
    }
    signalsSent += 1
    child.kill(opts.signal ?? 'SIGINT')
  }
  const watch = () => {
    if (triggered) {
      if (opts.again === undefined || signalsSent !== 1) return
      const since = stdout.slice(signalledAt.stdout) + stderr.slice(signalledAt.stderr)
      if (opts.again.test(stripAnsi(since))) stop()
      return
    }
    const text = stripAnsi(stdout + stderr)
    if ((opts.at ?? 'ready') === 'progress') {
      if (!PROGRESS_LINE.test(text)) return
      triggered = true
      stop()
      return
    }
    const m = ready(text)
    if (m === null) return
    triggered = true
    void (async () => {
      try {
        if (opts.whileUp) live = await opts.whileUp(m[1]!.replace(/\/+$/, ''))
      } catch (error) {
        liveError = error instanceof Error ? error.message : String(error)
      }
      stop()
    })()
  }
  child.stdout.on('data', (b: Buffer) => {
    stdout += b.toString()
    watch()
  })
  child.stderr.on('data', (b: Buffer) => {
    stderr += b.toString()
    watch()
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 150_000)
  const { code, signal: endedBy } = await exited
  clearTimeout(timer)
  const out = stripAnsi(stdout + stderr)
  const m = ready(out)
  return {
    code,
    signal: endedBy,
    stdout,
    stderr,
    out,
    ready: m !== null,
    apiUrl: m === null ? null : m[1]!.replace(/\/+$/, ''),
    tmp,
    dirsWhenSignalled,
    dirsAfter: previewDirs(tmp),
    live,
    liveError,
    signalsSent,
  }
}

/** Whether a port can be bound on 127.0.0.1 again. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

async function getJson<T>(url: string): Promise<{ status: number; data: T }> {
  const res = await fetch(url)
  const body = (await res.json().catch(() => ({}))) as { data?: T }
  return { status: res.status, data: body.data as T }
}

/** Every product GET /api/products serves, over all its pages. */
async function servedProducts(api: string): Promise<Array<{ slug: string; name: string }>> {
  const all: Array<{ slug: string; name: string }> = []
  let cursor: string | null = null
  do {
    const q: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
    const page = await getJson<{
      items: Array<{ slug: string; name: string }>
      nextCursor: string | null
    }>(`${api}/api/products?limit=100${q}`)
    all.push(...page.data.items)
    cursor = page.data.nextCursor
  } while (cursor !== null)
  return all
}

// ─── Reading what a run left ────────────────────────────────────────────────────────────────────────────────────────

/** Every file under `root` (symlinks not followed) by its path: SHA-256, `empty`, or `-> target` for a link. */
function treeOf(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const rel = relative(root, path)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) files.set(rel, `-> ${readlinkSync(path)}`)
      else if (stat.isDirectory()) walk(path)
      else if (!name.endsWith('-shm')) {
        const bytes = readFileSync(path)
        files.set(
          rel,
          bytes.length === 0 ? 'empty' : createHash('sha256').update(bytes).digest('hex'),
        )
      }
    }
  }
  walk(root)
  return files
}

/** Files added or changed since `before`, a `-wal` that went from absent to empty aside (a read-only open's). */
function changedSince(before: Map<string, string>, after: Map<string, string>) {
  const added: string[] = []
  const changed: string[] = []
  const removed = [...before.keys()].filter((p) => !after.has(p))
  for (const [path, hash] of after) {
    if (!before.has(path)) {
      if (path.endsWith('-wal') && hash === 'empty') continue
      added.push(path)
    } else if (before.get(path) !== hash) changed.push(path)
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

function readOutputs(dir: string) {
  return {
    report: JSON.parse(readFileSync(join(dir, OUTPUTS[0]!), 'utf8')) as PreviewReport,
    markdown: readFileSync(join(dir, OUTPUTS[1]!), 'utf8'),
    csv: readFileSync(join(dir, OUTPUTS[2]!), 'utf8'),
  }
}

/** The text of a `## ` section of the Markdown report, up to the next `## `. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

/** The `### <field> (<n>)` headings of the Differences section, field to n. */
function fieldHeadings(markdown: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of section(markdown, '## Differences').matchAll(/^### (\w+) \((\d+)\)\s*$/gm)) {
    out[m[1]!] = Number(m[2])
  }
  return out
}

/** Where the Markdown's field headings and the JSON's byField disagree: a headed count, or a counted field unheaded. */
function headingsDisagree(markdown: string, byField: Record<string, number>): string[] {
  const headed = fieldHeadings(markdown)
  return [
    ...Object.entries(headed)
      .filter(([f, n]) => byField[f] !== n)
      .map(([f, n]) => `### ${f} (${n}) but byField ${String(byField[f])}`),
    ...FIELDS.filter((f) => (byField[f] ?? 0) > 0 && headed[f] === undefined).map(
      (f) => `no ### ${f} heading for ${byField[f]}`,
    ),
  ]
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

interface KeptStore {
  state: KeptState
  /** Each imported product by WooCommerce id: its slug and status in the preview's own store. */
  products: Map<number, { slug: string; status: string }>
  activeRows: number
  categoryRows: number
}

function keptStore(dir: string): KeptStore {
  const state = JSON.parse(readFileSync(join(dir, '.nymbal-migration.json'), 'utf8')) as KeptState
  const db = join(dir, 'preview.db')
  const rows = readRows<{ id: string; slug: string; status: string }>(
    db,
    'SELECT id, slug, status FROM products',
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const products = new Map<number, { slug: string; status: string }>()
  for (const [wcId, id] of Object.entries(state['wcToNymbalProduct'] as Record<string, string>)) {
    const row = byId.get(id)
    if (row !== undefined) products.set(Number(wcId), { slug: row.slug, status: row.status })
  }
  return {
    state,
    products,
    activeRows: rows.filter((r) => r.status === 'active').length,
    categoryRows: readRows<{ n: number }>(db, 'SELECT count(*) AS n FROM categories')[0]!.n,
  }
}

const mapSize = (state: KeptState, e: Entity) =>
  Object.keys((state[STATE_MAP[e]] as Record<string, string> | undefined) ?? {}).length

// ─── The test's own reading of a recorded store ─────────────────────────────────────────────────────────────────────

/** A WooCommerce price's digits past the currency's exponent hold something other than zeros. */
function losesDigits(price: string, currency: string): boolean {
  const fraction = price.split('.')[1] ?? ''
  return /[1-9]/.test(fraction.slice(currencyDigits(currency)))
}

function atExponent(minor: number, currency: string): string {
  const exp = currencyDigits(currency)
  if (exp === 0) return String(minor)
  return `${Math.floor(minor / 10 ** exp)}.${String(minor % 10 ** exp).padStart(exp, '0')}`
}

const shown = (min: string, max: string) => (min === max ? min : `${min}–${max}`)

/**
 * The differences a listed product must show: its price when the cheapest or dearest sellable price has digits the
 * currency cannot hold, and its images when they were made to fail.
 */
function ownReading(store: RecordedStore, listed: Set<number>, failImages: number[]) {
  const expected = new Map<string, Array<{ field: string; source: string; preview: string }>>()
  for (const p of store.products) {
    const id = p['id'] as number
    if (!listed.has(id)) continue
    const prices =
      p['type'] === 'variable'
        ? (store.variations[id] ?? [])
            .filter((v) => v['status'] === 'publish' && v['price'] !== '')
            .map((v) => v['price'] as string)
        : [p['price'] as string]
    const byValue = [...prices].sort((a, b) => Number(a) - Number(b))
    const [min, max] = [byValue[0]!, byValue[byValue.length - 1]!]
    const changes: Array<{ field: string; source: string; preview: string }> = []
    if (losesDigits(min, store.currency) || losesDigits(max, store.currency)) {
      changes.push({
        field: 'price',
        source: shown(min, max),
        preview: shown(
          atExponent(minorUnits(min, store.currency)!, store.currency),
          atExponent(minorUnits(max, store.currency)!, store.currency),
        ),
      })
    }
    const images = ((p['images'] as Rec[] | undefined) ?? []).filter((i) => i['src'] !== '').length
    if (failImages.includes(id) && images > 0) {
      changes.push({ field: 'images', source: String(images), preview: '0' })
    }
    if (changes.length > 0) expected.set(p['slug'] as string, changes)
  }
  return expected
}

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────────

const scratch: string[] = []
const projects: StoreProject[] = []
const servers: WooCommerceServer[] = []

afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const p of projects.splice(0)) p.remove()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(
  config: Record<string, unknown> = storeConfig(),
  installed?: Record<string, string>,
) {
  const p = storeProject(config, installed)
  projects.push(p)
  return p
}

function inCurrency(currency: string): Record<string, unknown> {
  const config = storeConfig()
  config['store'] = { ...(config['store'] as Record<string, unknown>), currency }
  return config
}

async function woo(opts: Parameters<typeof startWooCommerceServer>[0]): Promise<WooCommerceServer> {
  const server = await startWooCommerceServer(opts)
  servers.push(server)
  return server
}

const source = (url: string) => [
  '--source',
  'woocommerce',
  '--url',
  url,
  '--key',
  KEY,
  '--secret',
  SECRET,
]

/** The fixture source with customers and orders, as every unrecorded case uses it. */
const withShoppers = () =>
  woo({ imagesPerProduct: 1, customers: fixture('customers'), orders: fixture('orders') })

// ─── AC-4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("AC-4: the merchant's store is untouched", () => {
  let server: WooCommerceServer
  let dir: string
  let env: Record<string, string>
  let before: Map<string, string>
  const MERCHANT_FILES = [
    'nymbal.db',
    '.nymbal-migration.json',
    'nymbal-migration-report.md',
    'nymbal-import-plan.json',
  ]

  beforeAll(async () => {
    server = await withShoppers()
    const p = project()
    dir = p.dir
    env = { NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db') }
    const run = (args: string[]) => runCli(args, { cwd: dir, env: cliEnv(env), timeoutMs: 120_000 })
    const steps = [
      await run(['migrate']),
      await run(['import', ...source(server.url), '--no-ai']),
      await run(['import', '--dry-run', ...source(server.url)]),
    ]
    expect(
      steps.map((s) => s.code),
      steps.map((s) => s.out.slice(-1500)).join('\n---\n'),
    ).toEqual([0, 0, 0])
    expect(MERCHANT_FILES.filter((f) => !existsSync(join(dir, f)))).toEqual([])
    expect(
      readdirSync(join(dir, 'public', 'imported-media'), { recursive: true }).length,
    ).toBeGreaterThan(0)
    before = treeOf(dir)
  }, 400_000)

  /** What the run changed under the project root, the three preview outputs aside. */
  const merchantChanges = () => {
    const { added, changed, removed } = changedSince(before, treeOf(dir))
    return {
      added: added.filter((p) => !OUTPUTS.includes(p)),
      changed: changed.filter((p) => !OUTPUTS.includes(p)),
      removed,
    }
  }
  const untouched = { added: [], changed: [], removed: [] }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`AC-4: stopped with ${signal} at Preview ready, the preview exits 0, every file of the merchant's is byte-identical, only the three outputs are new, and the temporary directory it made is gone`, async () => {
      const run = await preview([...source(server.url), '--api-only'], { cwd: dir, env, signal })

      expect(run.ready, run.out.slice(-3000)).toBe(true)
      expect([run.code, run.signal]).toEqual([0, null])
      expect(merchantChanges()).toEqual(untouched)
      expect(OUTPUTS.filter((f) => !existsSync(join(dir, f)))).toEqual([])
      expect([run.dirsWhenSignalled.length, run.dirsAfter]).toEqual([1, []])
    }, 200_000)
  }

  it("AC-4: with --keep the directory remains, is printed, and holds preview.db, and the merchant's files are untouched", async () => {
    const run = await preview([...source(server.url), '--api-only', '--keep'], { cwd: dir, env })

    expect(run.ready, run.out.slice(-3000)).toBe(true)
    expect(run.code).toBe(0)
    expect(run.dirsAfter).toEqual(run.dirsWhenSignalled)
    expect(run.dirsAfter).toHaveLength(1)
    const kept = join(run.tmp, run.dirsAfter[0]!)
    expect(run.out).toContain(run.dirsAfter[0]!)
    expect(existsSync(join(kept, 'preview.db'))).toBe(true)
    expect(merchantChanges()).toEqual(untouched)
  }, 200_000)

  it("AC-4: SIGINT on the first import progress line leaves the directory gone and the merchant's files byte-identical", async () => {
    const run = await preview([...source(server.url), '--api-only'], {
      cwd: dir,
      env,
      at: 'progress',
    })

    expect(PROGRESS_LINE.test(run.out), run.out.slice(-3000)).toBe(true)
    expect(run.signal).toBe(null)
    expect([run.dirsWhenSignalled.length, run.dirsAfter]).toEqual([1, []])
    expect(merchantChanges()).toEqual(untouched)
  }, 200_000)

  // Kills: a repeated Ctrl-C while a slow dev server stops ending the preview at once, leaving the project's files as
  // the dev server rewrote them, its dist dir and the temporary directory behind.
  it("AC-4: a second SIGINT while a slow storefront stops still restores the project's files, removes the directory and exits 0", async () => {
    const p = project(storeConfig({}, 'nextjs'))
    writeFileSync(join(p.dir, 'next.config.mjs'), 'export default {}\n')
    writeFileSync(join(p.dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n')
    writeFileSync(join(p.dir, 'next-env.d.ts'), '/// <reference types="next" />\n')
    // A `next dev` that rewrites what Next rewrites, builds into its dist dir and ignores SIGTERM until it is killed.
    const bin = join(p.dir, 'node_modules', '.bin', 'next')
    mkdirSync(join(p.dir, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(
      bin,
      `#!${process.execPath}
const { createServer } = process.getBuiltinModule('node:http')
const { mkdirSync, writeFileSync } = process.getBuiltinModule('node:fs')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const dist = process.env.NYMBAL_NEXT_DIST_DIR
mkdirSync(dist + '/types', { recursive: true })
writeFileSync(dist + '/types/routes.d.ts', 'export {}\\n')
writeFileSync('next-env.d.ts', '/// <reference path="./' + dist + '/types/routes.d.ts" />\\n')
writeFileSync('tsconfig.json', '{ "include": ["' + dist + '/types/**/*.ts"] }\\n')
writeFileSync('tsconfig.dist.json', '{}\\n')
process.on('SIGTERM', () => process.stdout.write('stand-in storefront: SIGTERM ignored\\n'))
setTimeout(() => process.exit(0), 60_000)
createServer((_, res) => res.end('ok')).listen(port)
`,
    )
    chmodSync(bin, 0o755)
    const before = treeOf(p.dir)

    const run = await preview(
      [...source(server.url), '--storefront-port', String(await freePort())],
      { cwd: p.dir, again: /SIGTERM ignored/ },
    )

    expect(run.ready, run.out.slice(-3000)).toBe(true)
    expect(run.signalsSent).toBe(2)
    expect([run.code, run.signal], run.out.slice(-3000)).toEqual([0, null])
    const { added, changed, removed } = changedSince(before, treeOf(p.dir))
    expect({ added: added.filter((f) => !OUTPUTS.includes(f)), changed, removed }).toEqual(
      untouched,
    )
    expect([run.dirsWhenSignalled.length, run.dirsAfter]).toEqual([1, []])
  }, 200_000)
})

// ─── AC-5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-5: no mail, no AI', () => {
  let smtp: FakeSmtpServer
  let ai: AiStandIn
  let runs: Array<PreviewRun<{ registered: number; delivers: unknown }>>
  let aiRequestsWithoutAi: number
  let aiRun: PreviewRun<undefined>

  beforeAll(async () => {
    smtp = await fakeSmtpServer()
    ai = await startAiStandIn('anthropic')
    const server = await withShoppers()
    const config = storeConfig()
    config['commerce'] = {
      ...(config['commerce'] as Record<string, unknown>),
      email: {
        provider: 'smtp',
        config: {
          from: 'shop@preview.test',
          smtp: { host: '127.0.0.1', port: smtp.port, secure: false },
        },
      },
      ai: { provider: 'anthropic', config: { apiKey: 'sk-ant-preview-test', baseUrl: ai.url } },
    }
    const p = project(config, workspace('@nymbalhq/email-smtp', '@nymbalhq/ai-anthropic'))

    /** Registers a shopper through the preview's own API, which sends a welcome, and reads what email can do. */
    const register = async (api: string) => {
      const csrf = createHash('sha256').update(api).digest('hex')
      const res = await fetch(`${api}/api/auth/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `nymbal.csrf=${csrf}`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({
          email: 'new.shopper@example.com',
          password: 'preview-Passw0rd-long',
        }),
      })
      const capabilities = await getJson<{ email?: { delivers?: unknown } }>(
        `${api}/api/capabilities`,
      )
      return { registered: res.status, delivers: capabilities.data?.email?.delivers }
    }
    runs = []
    for (const gdpr of [[], ['--no-gdpr']]) {
      runs.push(
        await preview([...source(server.url), '--api-only', ...gdpr], {
          cwd: p.dir,
          whileUp: register,
        }),
      )
    }
    aiRequestsWithoutAi = ai.requests.length
    aiRun = await preview([...source(server.url), '--api-only', '--ai'], { cwd: p.dir })
  }, 500_000)

  afterAll(async () => {
    await smtp?.close()
    await ai?.close()
  })

  it("AC-5: previews with --gdpr and --no-gdpr reach Preview ready, a shopper registers through the preview's API, email reports it delivers nothing, and the SMTP server and the AI stand-in see nothing", () => {
    expect(
      runs.map((r) => ({ ready: r.ready, live: r.live, error: r.liveError })),
      runs.map((r) => r.out.slice(-2000)).join('\n---\n'),
    ).toEqual([
      { ready: true, live: { registered: 201, delivers: false }, error: null },
      { ready: true, live: { registered: 201, delivers: false }, error: null },
    ])
    expect({
      connections: smtp.connections(),
      messages: smtp.messages.length,
      ai: aiRequestsWithoutAi,
    }).toEqual({ connections: 0, messages: 0, ai: 0 })
  })

  it("AC-5: with --ai the project's AI provider is the one used: the stand-in receives requests it did not receive without it", () => {
    expect(aiRun.ready, aiRun.out.slice(-3000)).toBe(true)
    expect(ai.requests.length).toBeGreaterThan(aiRequestsWithoutAi)
    expect(smtp.connections()).toBe(0)
  })
})

// ─── AC-6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("AC-6: counts, warnings and the report's shape", () => {
  // A simple product whose slug slugifies as the variable graphic-logo-tee's (101), after it in the source: the
  // import reads 101's variations first, so the twin is ready to be created before it, and must still be the refusal.
  const twin = {
    ...fixture('products')[0]!,
    id: 102,
    slug: 'graphic_logo_tee',
    sku: 'GLT-TWIN',
    name: 'Graphic Logo Tee (twin)',
  }
  const reviews = [100, 999].map((productId, i) => ({
    id: i + 1,
    product_id: productId,
    reviewer: `Reviewer ${i + 1}`,
    reviewer_email: `reviewer${i + 1}@example.com`,
    review: 'Lovely.',
    rating: 5,
    verified: false,
    date_created: '2024-03-01T09:00:00',
    date_created_gmt: '2024-03-01T09:00:00',
  }))
  let server: WooCommerceServer
  let dir: string
  let run: PreviewRun<undefined>
  /** The run's outputs and kept store, once it is known to have reached Preview ready. */
  const got = () => {
    expect(run.ready, run.out.slice(-3000)).toBe(true)
    return { outputs: readOutputs(dir), kept: keptStore(join(run.tmp, run.dirsAfter[0]!)) }
  }
  const served: Record<Entity, number> = {
    categories: fixture('categories').length,
    products: fixture('products').length + 1,
    customers: fixture('customers').length,
    orders: fixture('orders').length,
    reviews: reviews.length,
  }

  beforeAll(async () => {
    server = await woo({
      imagesPerProduct: 1,
      extraProducts: [twin],
      customers: fixture('customers'),
      orders: fixture('orders'),
      reviews,
    })
    dir = project().dir
    run = await preview([...source(server.url), '--api-only', '--keep', '--entities', ALL], {
      cwd: dir,
    })
  }, 300_000)

  it("AC-6: for every entity source = imported + refused + skipped, imported is the kept state's map, planned equals imported, the slug twin is the one refusal and the review of an absent product the one skip", () => {
    const { outputs, kept } = got()
    const { counts } = outputs.report
    const relation = ENTITIES.map((e) => ({
      e,
      source: counts[e].source,
      sum: counts[e].imported + counts[e].refused + counts[e].skipped,
      imported: counts[e].imported,
      inState: mapSize(kept.state, e),
      planned: counts[e].planned,
    }))
    expect(relation).toEqual(
      ENTITIES.map((e) => ({
        e,
        source: served[e],
        sum: served[e],
        imported: mapSize(kept.state, e),
        inState: mapSize(kept.state, e),
        planned: mapSize(kept.state, e),
      })),
    )
    expect([counts.products.refused, counts.reviews.skipped]).toEqual([1, 1])
  })

  it('AC-6: served products are the active rows of the preview store and served categories its category rows', () => {
    const { outputs, kept } = got()
    const { counts } = outputs.report
    expect([counts.products.served, counts.categories.served]).toEqual([
      kept.activeRows,
      kept.categoryRows,
    ])
    expect([counts.customers.served, counts.orders.served, counts.reviews.served]).toEqual([
      null,
      null,
      null,
    ])
  })

  it('AC-6: the refused product is the twin later in the source, unredirected with its refusal', () => {
    const { outputs } = got()
    const refused = outputs.report.errors
      .filter((e) => e.phase === 'products')
      .map((e) => Number(e.id))
    expect(refused).toEqual([twin.id])
    const entry = outputs.report.redirects.unredirected.find(
      (u) => u.kind === 'product' && u.wcId === refused[0],
    )
    expect(entry?.reason.startsWith('refused: ')).toBe(true)
  })

  it("AC-6: the warnings are the kept state's, each once under Review before launch", () => {
    const { outputs, kept } = got()
    const review = section(outputs.markdown, '## Review before launch')
    expect(outputs.report.warnings).toEqual(kept.state.warnings)
    expect(kept.state.warnings.some((w) => /settings/i.test(w.message))).toBe(true)
    expect(kept.state.warnings.map((w) => occurrences(review, w.message))).toEqual(
      kept.state.warnings.map(() => 1),
    )
  })

  it('AC-6: the JSON holds every report key, lighthouse null without --lighthouse, and the Markdown the seven sections in order', () => {
    const { outputs } = got()
    const { report, markdown } = outputs
    expect(Object.keys(report).sort()).toEqual(
      [
        'counts',
        'currency',
        'differences',
        'entities',
        'errors',
        'generatedAt',
        'lighthouse',
        'notListed',
        'redirects',
        'source',
        'unmapped',
        'warnings',
      ].sort(),
    )
    expect(report.lighthouse).toBeNull()
    expect(ENTITIES.map((e) => Object.keys(report.counts[e]).sort())).toEqual(
      ENTITIES.map(() => ['imported', 'planned', 'refused', 'served', 'skipped', 'source']),
    )
    expect(Object.keys(report.differences.byField).sort()).toEqual([...FIELDS].sort())
    expect(Object.keys(report.redirects).sort()).toEqual(['duplicates', 'rows', 'unredirected'])
    expect(report.source.url).toBe(server.url)
    expect(markdown.split('\n').filter((l) => l.startsWith('## '))).toEqual(SECTIONS)
  })

  it("AC-6: neither the key and secret nor, under --gdpr, any customer's or order's email, name, phone, address line or postcode is in an output file, stdout or stderr", () => {
    const { outputs } = got()
    const texts = {
      json: JSON.stringify(outputs.report),
      jsonFile: readFileSync(join(dir, OUTPUTS[0]!), 'utf8'),
      markdown: outputs.markdown,
      csv: outputs.csv,
      stdout: run.stdout,
      stderr: run.stderr,
    }
    const secrets = [KEY, SECRET, Buffer.from(`${KEY}:${SECRET}`).toString('base64')]
    const people = [...fixture('customers'), ...fixture('orders')].flatMap((r) => {
      const parts = [r, r['billing'], r['shipping']] as Array<Record<string, unknown> | undefined>
      return parts.flatMap((part) =>
        ['email', 'first_name', 'last_name', 'phone', 'address_1', 'address_2', 'postcode']
          .map((k) => part?.[k])
          .filter((v): v is string => typeof v === 'string' && v.length >= 3),
      )
    })
    const leaks = Object.entries(texts).flatMap(([where, text]) =>
      [...secrets, ...new Set(people)].filter((s) => text.includes(s)).map((s) => `${where}: ${s}`),
    )
    expect(leaks).toEqual([])
  })
})

// ─── AC-7, AC-8, AC-11: the recorded stores ─────────────────────────────────────────────────────────────────────────

interface RecordedRun {
  store: RecordedStore
  dir: string
  run: PreviewRun<{ unresolved: string[]; servedProducts: number }>
  failImages: number[]
}

/** One preview of a recorded store in a project in its own currency, every `to` of the redirect map tried on its API. */
async function previewRecorded(
  name: RecordedStoreName,
  failImages: number[] = [],
): Promise<RecordedRun> {
  const store = loadRecordedStore(name)
  const server = await woo({ recorded: name, failImages })
  const dir = project(inCurrency(store.currency)).dir
  const run = await preview([...source(server.url), '--api-only', '--keep', '--entities', ALL], {
    cwd: dir,
    whileUp: async (api) => {
      const rows = parseCsv(readFileSync(join(dir, 'nymbal-redirects.csv'), 'utf8')).slice(1)
      const categories = await getJson<Array<{ slug: string }>>(`${api}/api/categories`)
      const categorySlugs = new Set(categories.data.map((c) => c.slug))
      const unresolved: string[] = []
      for (const [, to] of rows) {
        const product = /^\/product\/([^/]+)$/.exec(to ?? '')
        const category = /^\/category\/([^/]+)$/.exec(to ?? '')
        const ok = product
          ? (await fetch(`${api}/api/products/${product[1]}`)).status === 200
          : category !== null && categorySlugs.has(category[1]!)
        if (!ok) unresolved.push(to ?? '')
      }
      return { unresolved, servedProducts: (await servedProducts(api)).length }
    },
  })
  return { store, dir, run, failImages }
}

const listedOf = (kept: KeptStore) =>
  new Set([...kept.products].filter(([, p]) => p.status === 'active').map(([wcId]) => wcId))
const draftsOf = (kept: KeptStore) =>
  [...kept.products]
    .filter(([, p]) => p.status !== 'active')
    .map(([wcId]) => wcId)
    .sort((a, b) => a - b)

const recorded: Partial<Record<RecordedStoreName, RecordedRun>> = {}
const RECORDED: Array<{ name: RecordedStoreName; failImages: number[] }> = [
  { name: 'store-a-gbp', failImages: [14] },
  { name: 'store-b-jpy', failImages: [] },
  { name: 'store-c-eur', failImages: [] },
]

/** A recorded store's preview, its outputs and its kept store, once it is known to have reached Preview ready. */
function runOf(name: RecordedStoreName) {
  const r = recorded[name]!
  expect(r.run.ready, `${name}: ${r.run.out.slice(-3000)}`).toBe(true)
  return {
    ...r,
    outputs: readOutputs(r.dir),
    kept: keptStore(join(r.run.tmp, r.run.dirsAfter[0]!)),
  }
}

describe('previews of the recorded stores', () => {
  beforeAll(async () => {
    for (const { name, failImages } of RECORDED)
      recorded[name] = await previewRecorded(name, failImages)
  }, 600_000)

  describe('AC-7: the diff on a recorded store', () => {
    it("AC-7: store A, product 14's image failing: the differences are exactly the test's own reading (tea-sampler's price 4.995 to 5.00, canvas-tote's images 1 to 0), each product once, byField summing to the changes", () => {
      const { store, outputs, kept, failImages } = runOf('store-a-gbp')
      const expected = ownReading(store, listedOf(kept), failImages)
      const { products, byField } = outputs.report.differences

      expect(Object.fromEntries(products.map((p) => [p.slug, p.changes]))).toEqual(
        Object.fromEntries(expected),
      )
      expect(expected.get('tea-sampler')).toEqual([
        { field: 'price', source: '4.995', preview: '5.00' },
      ])
      expect(expected.get('canvas-tote')).toEqual([{ field: 'images', source: '1', preview: '0' }])
      expect(new Set(products.map((p) => p.slug)).size).toBe(products.length)
      const changes = products.flatMap((p) => p.changes)
      expect(Object.values(byField).reduce((a, b) => a + b, 0)).toBe(changes.length)
      expect(FIELDS.map((f) => byField[f])).toEqual(
        FIELDS.map((f) => changes.filter((c) => c.field === f).length),
      )
    })

    it("AC-7: the Markdown's Differences name each differing product and count each field as the JSON does", () => {
      const { outputs } = runOf('store-a-gbp')
      const text = section(outputs.markdown, '## Differences')
      const { products, byField } = outputs.report.differences

      expect(products.filter((p) => !text.includes(p.name)).map((p) => p.slug)).toEqual([])
      expect(headingsDisagree(outputs.markdown, byField)).toEqual([])
    })

    it('AC-7: notListed is the imported products the preview store does not hold active', () => {
      const { outputs, kept } = runOf('store-a-gbp')
      expect(outputs.report.notListed.map((p) => p.wcId).sort((a, b) => a - b)).toEqual(
        draftsOf(kept),
      )
    })
  })

  describe('AC-8: the redirects served', () => {
    for (const name of ['store-a-gbp', 'store-b-jpy'] as const) {
      it(`AC-8: ${name}: the CSV has the header and a row per served category and product, each product from its permalink's path, every to served by the preview API, no from twice, and every imported draft unredirected`, () => {
        const { store, run, outputs, kept } = runOf(name)
        const [header, ...rows] = parseCsv(outputs.csv)
        const { counts, redirects } = outputs.report

        expect(header).toEqual(['from', 'to', 'status'])
        expect(rows.length).toBe(counts.categories.served! + counts.products.served!)
        expect(rows.length).toBe(redirects.rows)
        expect(new Set(rows.map((r) => r[0])).size).toBe(rows.length)
        expect(run.live?.unresolved, run.liveError ?? '').toEqual([])

        const fromBySlug = Object.fromEntries(
          rows
            .filter((r) => r[1]!.startsWith('/product/'))
            .map((r) => [r[1]!.slice('/product/'.length), r[0]]),
        )
        const listed = listedOf(kept)
        const expected = Object.fromEntries(
          store.products
            .filter((p) => listed.has(p['id'] as number))
            .map((p) => [
              kept.products.get(p['id'] as number)!.slug,
              new URL(p['permalink'] as string).pathname,
            ]),
        )
        expect(fromBySlug).toEqual(expected)

        const unredirected = new Set(
          redirects.unredirected.filter((u) => u.kind === 'product').map((u) => u.wcId),
        )
        expect(draftsOf(kept).filter((id) => !unredirected.has(id))).toEqual([])
      })
    }

    it("AC-8: store B's matcha row is /product-category/food/tea/matcha/,/category/matcha,301, and staff-mug and ceramic-coaster are among its drafts", () => {
      const { outputs, kept, store } = runOf('store-b-jpy')
      const idOf = (slug: string) => store.products.find((p) => p['slug'] === slug)!['id'] as number

      expect(outputs.csv.split('\n')).toContain(
        '/product-category/food/tea/matcha/,/category/matcha,301',
      )
      expect(
        ['staff-mug', 'ceramic-coaster'].filter((s) => !draftsOf(kept).includes(idOf(s))),
      ).toEqual([])
    })
  })

  describe('AC-11: the row proof over three recorded stores', () => {
    for (const { name } of RECORDED) {
      it(`AC-11: ${name}: each source count is WooCommerce's X-WP-Total, there are no errors, planned equals imported, every product is imported, served products are the active rows, and the Differences are the test's own reading`, () => {
        const { store, run, outputs, kept, failImages } = runOf(name)
        const { counts, errors, differences } = outputs.report
        const recordedEntities = ENTITIES.filter((e) => store.totals[TOTAL_FILE[e]] !== undefined)

        expect(recordedEntities.map((e) => [e, counts[e].source])).toEqual(
          recordedEntities.map((e) => [e, store.totals[TOTAL_FILE[e]]]),
        )
        expect(errors).toEqual([])
        expect(ENTITIES.map((e) => [e, counts[e].planned])).toEqual(
          ENTITIES.map((e) => [e, counts[e].imported]),
        )
        expect(counts.products.imported).toBe(counts.products.source)
        expect([counts.products.served, run.live?.servedProducts]).toEqual([
          kept.activeRows,
          kept.activeRows,
        ])

        const expected = ownReading(store, listedOf(kept), failImages)
        expect(differences.products.map((p) => p.slug).sort()).toEqual([...expected.keys()].sort())
        expect(Object.keys(differences.byField).sort()).toEqual([...FIELDS].sort())
        expect(headingsDisagree(outputs.markdown, differences.byField)).toEqual([])
        expect(section(outputs.markdown, '## Differences').trim() === 'None.').toBe(
          expected.size === 0,
        )
      })
    }
  })
})

// ─── AC-9 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-9: refusals leave nothing behind', () => {
  let shoppers: WooCommerceServer

  beforeAll(async () => {
    shoppers = await withShoppers()
  })

  const leftovers = (dir: string, run: PreviewRun<unknown>) => ({
    outputs: OUTPUTS.filter((f) => existsSync(join(dir, f))),
    dirs: run.dirsAfter,
  })

  it('AC-9: a GBP project previewing a JPY store exits 1 before Preview ready with the currency message naming both, reads no products, writes no output, and frees its port and directory', async () => {
    const jpy = await woo({ recorded: 'store-b-jpy' })
    const dir = project().dir
    const port = await freePort()

    const run = await preview([...source(jpy.url), '--api-only', '--port', String(port)], {
      cwd: dir,
    })

    expect([run.code, run.ready]).toEqual([1, false])
    expect(linesNaming(run.stderr, 'JPY', 'GBP'), run.out.slice(-3000)).not.toEqual([])
    expect(jpy.requests.filter((r) => r.path === '/wp-json/wc/v3/products')).toEqual([])
    expect(leftovers(dir, run)).toEqual({ outputs: [], dirs: [] })
    expect(await portFree(port)).toBe(true)
  }, 200_000)

  it('AC-9: a --url nothing listens on exits 1 before Preview ready with the connection failure, writes no output, and frees its port and directory', async () => {
    const dir = project().dir
    const port = await freePort()
    const dead = `http://127.0.0.1:${await closedPort()}`

    const run = await preview([...source(dead), '--api-only', '--port', String(port)], { cwd: dir })

    expect([run.code, run.ready]).toEqual([1, false])
    expect(stripAnsi(run.stderr), run.out.slice(-3000)).toMatch(
      /fetch failed|ECONNREFUSED|Connection failed/,
    )
    expect(leftovers(dir, run)).toEqual({ outputs: [], dirs: [] })
    expect(await portFree(port)).toBe(true)
  }, 200_000)

  it('AC-9: with no --key and no WOOCOMMERCE_KEY it exits 1 naming both, before any request to the store', async () => {
    const dir = project().dir
    const requests = shoppers.requests.length

    const run = await preview(
      ['--source', 'woocommerce', '--url', shoppers.url, '--secret', SECRET, '--api-only'],
      { cwd: dir, env: { WOOCOMMERCE_KEY: undefined, WOOCOMMERCE_SECRET: undefined } },
    )

    expect([run.code, run.ready]).toEqual([1, false])
    expect(linesNaming(run.stderr, '--key', 'WOOCOMMERCE_KEY'), run.out.slice(-3000)).not.toEqual(
      [],
    )
    expect(shoppers.requests.length).toBe(requests)
    expect(leftovers(dir, run)).toEqual({ outputs: [], dirs: [] })
  }, 200_000)

  it('AC-9: a failure after the API is listening (the redirect map cannot be written) exits 1 naming it, and frees the port and the directory', async () => {
    const dir = project().dir
    mkdirSync(join(dir, 'nymbal-redirects.csv'))
    const port = await freePort()

    const run = await preview([...source(shoppers.url), '--api-only', '--port', String(port)], {
      cwd: dir,
    })

    expect([run.code, run.ready]).toEqual([1, false])
    expect(stripAnsi(run.stderr), run.out.slice(-3000)).toMatch(/nymbal-redirects\.csv|EISDIR/)
    expect(run.dirsAfter).toEqual([])
    expect(await portFree(port)).toBe(true)
  }, 200_000)
})
