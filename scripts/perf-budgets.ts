import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'
import { launch } from 'chrome-launcher'
import lighthouse from 'lighthouse'
import puppeteer, { type Browser } from 'puppeteer-core'
import { seedProducts } from '../packages/platform/src/seed/data.js'
import {
  checkBudgets,
  METRICS,
  NO_BUDGET,
  NOT_MEASURED,
  type Budgets,
  type Metrics,
  type PageResult,
} from './perf-budgets-check.js'
import { stack } from './stack.js'

// pnpm perf:budgets [--template astro|nextjs] [--update] [--runs n] [--dir <template copy>]
//
// Builds the templates for production, serves them (Astro `preview`, Next `start`) against an API seeded with
// images the store serves itself, runs Lighthouse (mobile preset) `--runs` times a page, and compares each metric's
// median with perf-budgets.json. Writes reports/perf-budgets.json and exits 1 when any page is over budget.
// --update rewrites the budgets from this run: the absolute limits, and scriptBytes at the measured value plus 5%,
// rounded up to the next KiB. --dir measures a copy of one template. The templates are always built here: the seed
// images must be in a template's public directory when it is built.

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUDGETS_FILE = join(REPO, 'perf-budgets.json')
const REPORT_FILE = join(REPO, 'reports/perf-budgets.json')
const CLI = join(REPO, 'packages/cli/bin/nymbal.mjs')

export const LIMITS = { lcpMs: 2500, cls: 0.1, tbtMs: 200 } as const
const SCRIPT_HEADROOM = 1.05
const KIB = 1024

const TEMPLATES = ['astro', 'nextjs'] as const
type Template = (typeof TEMPLATES)[number]

interface PageSpec {
  page: string
  path: string
  /** The page is measured with one line in the cart. */
  line: boolean
}

const PRODUCT = seedProducts[0]!.slug
const PAGES: PageSpec[] = [
  { page: 'home', path: '/', line: false },
  { page: 'listing', path: '/products', line: false },
  { page: 'product', path: `/product/${PRODUCT}`, line: false },
  { page: 'cart', path: '/cart', line: true },
  { page: 'checkout', path: '/checkout', line: true },
]

interface ReportRow {
  template: string
  page: string
  url: string
  measured: Metrics
  budget: Metrics | null
  ok: boolean
  failures: string[]
}

/** A run that cannot measure. It is reported, with exit 2, once the servers are stopped and the images removed. */
class RunError extends Error {}

function fail(message: string): never {
  throw new RunError(message)
}

function options(): {
  templates: Template[]
  update: boolean
  runs: number
  dir: string | undefined
} {
  const { values } = parseArgs({
    options: {
      template: { type: 'string' },
      update: { type: 'boolean', default: false },
      runs: { type: 'string', default: '3' },
      dir: { type: 'string' },
    },
  })
  const template = values.template
  if (template !== undefined && !(TEMPLATES as readonly string[]).includes(template)) {
    fail(`--template must be astro or nextjs; got "${template}"`)
  }
  const runs = Number(values.runs)
  if (!Number.isInteger(runs) || runs < 1)
    fail(`--runs must be a positive integer; got "${values.runs}"`)
  if (values.dir !== undefined && template === undefined)
    fail('--dir measures one template: give --template')
  if (values.dir !== undefined && values.update)
    fail('--update writes the committed budgets: not with --dir')
  return {
    templates: template === undefined ? [...TEMPLATES] : [template as Template],
    update: values.update,
    runs,
    dir: values.dir === undefined ? undefined : resolve(values.dir),
  }
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].flatMap((bin) =>
      (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, bin)),
    ),
  ]
  const found = candidates.find((p): p is string => p !== undefined && p !== '' && existsSync(p))
  if (found === undefined)
    fail('no Chrome: set CHROME_PATH, or put google-chrome or chromium on PATH')
  return found
}

const children: ChildProcess[] = []
/** The seed images put in a template's public directory, and the run's own directory: removed when it ends. */
const placed: string[] = []
let work: string | undefined

/** A long-running server in its own process group, so stopping it stops what it spawned. */
function serve(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-8000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  child.on('exit', (code, signal) => {
    if (!stopping) {
      process.stderr.write(`${command} ${args.join(' ')} exited (${code ?? signal}):\n${output}\n`)
    }
  })
  children.push(child)
  return child
}

let stopping = false
function cleanUp(): void {
  stopAll()
  for (const dir of placed.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
}

function stopAll(): void {
  stopping = true
  for (const child of children) {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already gone: nothing of ours to stop.
      }
    }
  }
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  shell = false,
): void {
  process.stdout.write(`$ ${command} ${args.join(' ')}  (in ${cwd})\n`)
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell,
  })
  if (result.status !== 0)
    fail(`${command} ${args.join(' ')} failed (${result.status ?? result.signal})`)
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) fail(`${url} did not answer within ${timeoutMs / 1000} s`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

function median(values: number[]): number {
  if (values.some((v) => Number.isNaN(v))) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** One line in the cart, added from the product page as a shopper would, then the HTTP cache emptied again. */
async function addOneLine(browser: Browser, origin: string): Promise<void> {
  const page = await browser.newPage()
  await page.goto(`${origin}/product/${PRODUCT}`, { waitUntil: 'load' })
  const added = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/cart/.test(r.url()) && r.ok(),
    { timeout: 30_000 },
  )
  await page.locator('pierce/[data-testid="add-to-cart"]').setTimeout(30_000).click()
  await added
  const cdp = await page.createCDPSession()
  await cdp.send('Network.clearBrowserCache')
  await page.close()
}

async function scriptBytes(urls: string[]): Promise<number> {
  let total = 0
  for (const url of urls) {
    const response = await fetch(url)
    if (!response.ok) return Number.NaN
    total += gzipSync(Buffer.from(await response.arrayBuffer())).length
  }
  return total
}

interface NetworkRequest {
  url: string
  resourceType?: string
}

interface NodeItem {
  node?: { snippet?: string }
  score?: number
}

type Audits = Record<string, { numericValue?: number; details?: unknown } | undefined>

/** The LCP element and the element that shifted most, as Lighthouse names them: where a failing page starts. */
function culprits(audits: Audits): string {
  const items = (id: string): NodeItem[] =>
    (audits[id]?.details as { items?: NodeItem[] } | undefined)?.items ?? []
  const snippet = (item: NodeItem | undefined): string =>
    (item?.node?.snippet ?? '—').replace(/\s+/g, ' ').slice(0, 100)
  // The LCP element audit nests its node in a table of its own, and its phases (TTFB, load delay, load time, render
  // delay) in a second one.
  const tables = items('largest-contentful-paint-element') as Array<{ items?: unknown[] }>
  const lcp = tables[0]?.items?.[0] as NodeItem | undefined
  const phases = ((tables[1]?.items ?? []) as Array<{ phase?: string; timing?: number }>)
    .map((p) => `${p.phase} ${Math.round(p.timing ?? 0)}`)
    .join(', ')
  const shift = items('layout-shifts')[0]
  return `LCP ${snippet(lcp)} (${phases}); largest shift ${snippet(shift)} ${shift?.score?.toFixed(3) ?? ''}`
}

/**
 * One Lighthouse run in a fresh Chrome, launched as the Lighthouse CLI launches it (so the numbers are the ones anyone
 * running Lighthouse sees), with a fresh profile, so the cache is cold.
 */
async function measureOnce(
  chromePath: string,
  origin: string,
  spec: PageSpec,
): Promise<{ metrics: Metrics; culprits: string }> {
  const chrome = await launch({
    chromePath,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    if (spec.line) {
      const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` })
      try {
        await addOneLine(browser, origin)
      } finally {
        await browser.disconnect()
      }
    }
    // Storage is not reset: the cart line lives in a cookie. The profile is new, so nothing else carries over.
    const result = await lighthouse(`${origin}${spec.path}`, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance'],
      disableStorageReset: true,
    })
    if (result === undefined) return { metrics: nanMetrics(), culprits: 'no Lighthouse result' }
    const audits: Audits = result.lhr.audits
    const value = (id: string): number => audits[id]?.numericValue ?? Number.NaN
    const requests = (
      audits['network-requests']?.details as { items?: NetworkRequest[] } | undefined
    )?.items
    const scripts = (requests ?? [])
      .filter((r) => r.resourceType === 'Script' && /^https?:/.test(r.url))
      .map((r) => r.url)
    return {
      metrics: {
        lcpMs: value('largest-contentful-paint'),
        cls: value('cumulative-layout-shift'),
        tbtMs: value('total-blocking-time'),
        scriptBytes: requests === undefined ? Number.NaN : await scriptBytes(scripts),
      },
      culprits: culprits(audits),
    }
  } finally {
    chrome.kill()
  }
}

const nanMetrics = (): Metrics => ({
  lcpMs: Number.NaN,
  cls: Number.NaN,
  tbtMs: Number.NaN,
  scriptBytes: Number.NaN,
})

async function measure(
  chrome: string,
  template: Template,
  origin: string,
  runs: number,
): Promise<PageResult[]> {
  const results: PageResult[] = []
  for (const spec of PAGES) {
    const samples: Metrics[] = []
    for (let i = 0; i < runs; i++) {
      try {
        const sample = await measureOnce(chrome, origin, spec)
        samples.push(sample.metrics)
        process.stdout.write(
          `${template} / ${spec.page}: run ${i + 1}: lcp ${format('lcpMs', sample.metrics.lcpMs)} cls ${format('cls', sample.metrics.cls)}; ${sample.culprits}\n`,
        )
      } catch (error) {
        process.stderr.write(
          `${template} / ${spec.page}: run ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        samples.push(nanMetrics())
      }
    }
    const measured = Object.fromEntries(
      METRICS.map((m) => [m, median(samples.map((s) => s[m]))]),
    ) as Metrics
    process.stdout.write(
      `${template} / ${spec.page}: ${METRICS.map((m) => `${m} ${format(m, measured[m])}`).join(', ')}\n`,
    )
    results.push({ template, page: spec.page, url: spec.path, measured })
  }
  return results
}

function format(metric: string, value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—'
  return metric === 'cls' ? value.toFixed(3) : String(Math.round(value))
}

const templateDir = (template: Template, dir: string | undefined): string =>
  dir ?? join(REPO, 'templates', template)

const bin = (dir: string, name: string): string => join(dir, 'node_modules/.bin', name)

/** The seed images in the template's public directory, which the build copies (Astro) or serves (Next). */
function placeImages(media: string, dir: string): string {
  const target = join(dir, 'public/imported-media')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(media, target, { recursive: true })
  return target
}

/**
 * What a template is built and served with: this run's API, and production whatever the caller's NODE_ENV (a test
 * runner's `test` would build Lit's development bundle).
 */
const templateEnv = (api: string): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  NYMBAL_API_URL: api,
  PUBLIC_NYMBAL_API_URL: api,
  NEXT_PUBLIC_NYMBAL_API_URL: api,
})

function startStorefront(template: Template, dir: string, port: number, api: string): void {
  const env = templateEnv(api)
  if (template === 'astro') {
    // --ignore-lock: Astro backgrounds `astro preview` under an agent, as it does `astro dev`.
    serve(bin(dir, 'astro'), ['preview', '--ignore-lock', '--port', String(port)], dir, env)
  } else {
    serve(bin(dir, 'next'), ['start', '-p', String(port)], dir, env)
  }
}

function buildTemplate(dir: string, api: string): void {
  const env = templateEnv(api)
  // The template's own build script, so the run builds as CI and a store do. It is run here rather than through a
  // package manager: a copy outside the workspace (--dir) would have one install into the template it links to.
  const { scripts } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const script = scripts?.build
  if (script === undefined) fail(`${dir}/package.json has no build script`)
  run(
    script,
    [],
    dir,
    {
      ...env,
      PATH: `${join(dir, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
    true,
  )
}

function readBudgets(): Budgets {
  return existsSync(BUDGETS_FILE) ? (JSON.parse(readFileSync(BUDGETS_FILE, 'utf8')) as Budgets) : {}
}

function updatedBudgets(current: Budgets, results: PageResult[]): Budgets {
  const next: Budgets = structuredClone(current)
  for (const r of results) {
    const bytes = r.measured.scriptBytes
    if (Number.isNaN(bytes))
      fail(`${r.template} / ${r.page} was not measured; the budgets are left as they were`)
    ;(next[r.template] ??= {})[r.page] = {
      ...LIMITS,
      scriptBytes: Math.ceil((bytes * SCRIPT_HEADROOM) / KIB) * KIB,
    }
  }
  return next
}

async function main(): Promise<number> {
  const opts = options()
  const chrome = findChrome()
  const block = stack(REPO)
  const api = `http://localhost:${block.api}`
  const ports: Record<Template, number> = { astro: block.astro, nextjs: block.nextjs }

  work = mkdtempSync(join(tmpdir(), 'nymbal-perf-'))
  const media = join(work, 'media')
  const env = { NYMBAL_SQLITE_PATH: join(work, 'perf.db') }
  try {
    run('node', [CLI, 'seed', '--local-images', '--media-root', media], REPO, env)
    serve('node', [CLI, 'dev', '--api-only', '--port', String(block.api)], REPO, {
      ...env,
      NYMBAL_CORS_ORIGINS: opts.templates.map((t) => `http://localhost:${ports[t]}`).join(','),
    })
    await waitFor(`${api}/health`, 90_000)

    const results: PageResult[] = []
    for (const template of opts.templates) {
      const dir = templateDir(template, opts.dir)
      placed.push(placeImages(media, dir))
      buildTemplate(dir, api)
      startStorefront(template, dir, ports[template], api)
      const origin = `http://localhost:${ports[template]}`
      await waitFor(origin, 120_000)
      results.push(...(await measure(chrome, template, origin, opts.runs)))
    }

    let budgets = readBudgets()
    if (opts.update) {
      budgets = updatedBudgets(budgets, results)
      writeFileSync(BUDGETS_FILE, `${JSON.stringify(budgets, null, 2)}\n`)
      process.stdout.write(`perf-budgets.json updated from this run\n`)
    }
    const inScope: Budgets = Object.fromEntries(
      Object.entries(budgets).filter(([t]) => (opts.templates as string[]).includes(t)),
    )
    const verdicts = checkBudgets(results, inScope)
    const rows: ReportRow[] = verdicts.map((v) => {
      const result = results.find((r) => r.template === v.template && r.page === v.page)
      return {
        template: v.template,
        page: v.page,
        url: result?.url ?? PAGES.find((p) => p.page === v.page)?.path ?? '',
        measured: result?.measured ?? nanMetrics(),
        budget: inScope[v.template]?.[v.page] ?? null,
        ok: v.ok,
        failures: v.failures,
      }
    })
    mkdirSync(join(REPO, 'reports'), { recursive: true })
    writeFileSync(REPORT_FILE, `${JSON.stringify(rows, null, 2)}\n`)

    process.stdout.write(
      `\n${'template / page'.padEnd(27)}${METRICS.map((m) => `${m} (measured/budget)`.padEnd(24)).join('')}\n`,
    )
    for (const r of rows) {
      const cells = METRICS.map((m) =>
        `${format(m, r.measured[m])}/${format(m, r.budget?.[m])}`.padEnd(24),
      )
      process.stdout.write(
        `${`${r.template} / ${r.page}`.padEnd(27)}${cells.join('')}${r.ok ? 'ok' : 'FAIL'}\n`,
      )
    }
    const failing = rows.filter((r) => !r.ok)
    for (const r of failing) {
      for (const failure of r.failures) {
        if (failure === NOT_MEASURED || failure === NO_BUDGET) {
          process.stdout.write(`FAIL ${r.template} / ${r.page} / ${failure}\n`)
        } else {
          const metric = failure as keyof Metrics
          process.stdout.write(
            `FAIL ${r.template} / ${r.page} / ${metric}: measured ${format(metric, r.measured[metric])}, budget ${format(metric, r.budget?.[metric])}\n`,
          )
        }
      }
    }
    process.stdout.write(
      `\n${failing.length === 0 ? 'perf:budgets: every page within budget' : `perf:budgets: ${failing.length} page(s) over budget`} (${REPORT_FILE})\n`,
    )
    return failing.length === 0 ? 0 : 1
  } finally {
    cleanUp()
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cleanUp()
    process.exit(130)
  })
}
try {
  process.exitCode = await main()
} catch (error) {
  if (!(error instanceof RunError)) throw error
  process.stderr.write(`perf:budgets: ${error.message}\n`)
  process.exitCode = 2
}
