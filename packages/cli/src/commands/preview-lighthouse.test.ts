import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCsv } from '../../../../tests/support/csv.js'
import { CLI_BIN, cliEnv, freePort, runCli, stripAnsi } from '../../../../tests/support/doctor.js'
import {
  alive,
  storeConfig,
  storeProject,
  upstream,
  type StoreProject,
  type Upstream,
} from '../../../../tests/support/start.js'
import {
  fixture,
  productPagePath,
  startWooCommerceServer,
  type WooCommerceServer,
  type WooCommerceServerOptions,
} from '../../../../tests/support/woocommerce-server.js'

// `nymbal preview --lighthouse` through the built CLI (`pnpm build` first). The project has the Lighthouse stand-in
// (tests/support/lighthouse-stand-in.mjs) as node_modules/lighthouse, the storefront is the `nymbal start` stand-in
// through NYMBAL_STOREFRONT_ENTRY, Chrome is this Node (CHROME_PATH), and the source is the WooCommerce fixture server
// answering its pages. What the stand-in measured, in what order and with what arguments, is read from its log; what
// each page should show is worked out here from that log and the redirect map the preview wrote.

const KEY = 'ck_lighthouse_3a9d1f7e25b0c4'
const SECRET = 'cs_lighthouse_8e1b6d0a4f2c97'
const OUTPUTS = ['nymbal-preview-report.json', 'nymbal-preview-report.md', 'nymbal-redirects.csv']
const STAND_IN = fileURLToPath(
  new URL('../../../../tests/support/lighthouse-stand-in.mjs', import.meta.url),
)
const LHR_OK = fileURLToPath(
  new URL('../../../importers/tests/preview/fixtures/lhr-ok.json', import.meta.url),
)
const RECORDED = JSON.parse(readFileSync(LHR_OK, 'utf8')) as {
  lighthouseVersion: string
  configSettings: { emulatedUserAgent: string }
}
/** The user agent the recorded Lighthouse emulates on mobile: the warm-up's, so the source answers it as it would. */
const MOBILE_UA = RECORDED.configSettings.emulatedUserAgent
const PAGES = ['home', 'product', 'category'] as const
const SIDES = ['source', 'preview'] as const
const METRICS = ['performance', 'lcpMs', 'cls', 'tbtMs', 'bytes', 'serverMs'] as const
type Metric = (typeof METRICS)[number]
type Median = Record<Metric, number | null>

interface Side {
  url: string | null
  runs: unknown[]
  median: Median | null
  reason: string | null
}
interface Section {
  lighthouseVersion: string
  runs: number
  pairs: Array<{ page: string; source: Side; preview: Side }>
}

// ─── The Lighthouse stand-in ────────────────────────────────────────────────────────────────────────────────────────

type Answer = 'hang' | { runtimeError: { code: string; message: string } }
interface PlannedAnswer {
  port: number
  path?: string
  pathPrefix?: string
  answer: Answer
}
interface StartLine {
  event: 'start'
  url: string
  argv: string[]
  pid: number
  chromePid: number
  at: number
  answer: string
  sample: Median | null
}
interface EndLine {
  event: 'end'
  pid: number
  at: number
  code: number
}

const scratch: string[] = []
const projects: StoreProject[] = []
const servers: WooCommerceServer[] = []
const upstreams: Upstream[] = []
const logs: string[] = []

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** A plan file for the stand-in and a reader of its log. */
function standIn(answers: PlannedAnswer[] = []) {
  const dir = scratchDir('lighthouse-stand-in-')
  const log = join(dir, 'log.jsonl')
  logs.push(log)
  const plan = join(dir, 'plan.json')
  writeFileSync(plan, JSON.stringify({ log, fixture: LHR_OK, answers }))
  const lines = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l) as StartLine | EndLine)
      : []
  return {
    plan,
    starts: () => lines().filter((l): l is StartLine => l.event === 'start'),
    ends: () => lines().filter((l): l is EndLine => l.event === 'end'),
  }
}

/** The Lighthouse package as a project gets it: the stand-in as its CLI, at `version`. */
function lighthousePackage(at: string, version: string): void {
  mkdirSync(join(at, 'cli'), { recursive: true })
  writeFileSync(
    join(at, 'package.json'),
    `${JSON.stringify({ name: 'lighthouse', version, type: 'module', bin: { lighthouse: './cli/index.js' } }, null, 2)}\n`,
  )
  copyFileSync(STAND_IN, join(at, 'cli', 'index.js'))
}

/** `node_modules/lighthouse` in `dir`, laid out as npm does. */
function installLighthouse(dir: string, version = '12.6.1'): void {
  lighthousePackage(join(dir, 'node_modules', 'lighthouse'), version)
}

/**
 * pnpm's layout: `node_modules/lighthouse` links into `.pnpm/`, where `chrome-launcher` sits beside it and nowhere
 * else. This chrome-launcher finds no Chrome, as chrome-launcher 1.2.2 reports it.
 */
function installLighthousePnpm(dir: string, version = '12.6.1'): void {
  const store = join(dir, 'node_modules', '.pnpm', `lighthouse@${version}`, 'node_modules')
  lighthousePackage(join(store, 'lighthouse'), version)
  const launcher = join(store, 'chrome-launcher')
  mkdirSync(join(launcher, 'dist'), { recursive: true })
  writeFileSync(
    join(launcher, 'package.json'),
    `${JSON.stringify({ name: 'chrome-launcher', version: '1.2.2', type: 'module', main: './dist/index.js' }, null, 2)}\n`,
  )
  writeFileSync(
    join(launcher, 'dist', 'index.js'),
    `export class LauncherError extends Error {
  constructor(message = 'Unexpected error', code) {
    super(message)
    this.message = message
    this.code = code
  }
}
export class ChromeNotInstalledError extends LauncherError {
  constructor() {
    super('No Chrome installations found.', 'ERR_LAUNCHER_NOT_INSTALLED')
  }
}
export class Launcher {
  static getFirstInstallation() {
    return undefined
  }
  static getInstallations() {
    return []
  }
}
export function getChromePath() {
  throw new ChromeNotInstalledError()
}
export function launch() {
  return Promise.reject(new ChromeNotInstalledError())
}
export function killAll() {
  return []
}
export default Launcher
`,
  )
  symlinkSync(join(store, 'lighthouse'), join(dir, 'node_modules', 'lighthouse'), 'dir')
}

// ─── Running a preview ──────────────────────────────────────────────────────────────────────────────────────────────

interface PreviewRun {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  out: string
  ready: boolean
  /** Date.now() when `Preview ready` was seen. */
  readyAt: number | null
  /** The storefront origin printed after `Preview ready`. */
  storefront: string | null
  tmp: string
  /** `nymbal-preview-*` names seen in `tmp` while the run went on, and left after it. */
  dirsSeen: string[]
  dirsWhenSignalled: string[]
  dirsAfter: string[]
  /** Whether the trigger matched and the signal was sent. */
  signalled: boolean
}

const previewDirs = (tmp: string) =>
  existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith('nymbal-preview-')) : []

/**
 * `nymbal preview <args>` in `cwd` with a TMPDIR of its own. When `at` matches the output (by default `Preview
 * ready`), `signal` is sent and the run is waited for; a run that ends first ends the wait.
 */
async function preview(
  args: string[],
  opts: {
    cwd: string
    env: Record<string, string | undefined>
    /** When to send the signal: output matching, or a check of the output so far made every 100 ms. */
    at?: RegExp | ((text: string) => boolean)
    signal?: NodeJS.Signals
    timeoutMs?: number
  },
): Promise<PreviewRun> {
  const tmp = scratchDir('preview-lighthouse-tmpdir-')
  const seen = new Set<string>()
  const watcher = watch(tmp, (_, name) => {
    if (typeof name === 'string' && name.startsWith('nymbal-preview-')) seen.add(name)
  })
  const port = args.includes('--port') ? [] : ['--port', String(await freePort())]
  const child = spawn(process.execPath, [CLI_BIN, 'preview', ...args, ...port], {
    cwd: opts.cwd,
    env: cliEnv({ TMPDIR: tmp, ...opts.env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const at = opts.at ?? /Preview ready/
  let stdout = ''
  let stderr = ''
  let signalled = false
  let readyAt: number | null = null
  let dirsWhenSignalled: string[] = []
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  )
  const watchOutput = () => {
    const text = stripAnsi(stdout + stderr)
    if (readyAt === null && /Preview ready/.test(text)) readyAt = Date.now()
    if (signalled || !(typeof at === 'function' ? at(text) : at.test(text))) return
    // Preview ready is followed by the URLs; wait for the storefront's line before stopping.
    if (/Preview ready/.test(text) && !/Storefront:\s+\S+/.test(text)) return
    signalled = true
    for (const name of previewDirs(tmp)) seen.add(name)
    dirsWhenSignalled = previewDirs(tmp)
    child.kill(opts.signal ?? 'SIGINT')
  }
  child.stdout.on('data', (b: Buffer) => {
    stdout += b.toString()
    watchOutput()
  })
  child.stderr.on('data', (b: Buffer) => {
    stderr += b.toString()
    watchOutput()
  })
  const poll = typeof at === 'function' ? setInterval(watchOutput, 100) : undefined
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 180_000)
  const { code, signal } = await exited
  clearTimeout(timer)
  clearInterval(poll)
  watcher.close()
  const out = stripAnsi(stdout + stderr)
  const storefront = /Preview ready[\s\S]*?Storefront:\s+(https?:\/\/\S+)/.exec(out)
  return {
    code,
    signal,
    stdout: stripAnsi(stdout),
    stderr: stripAnsi(stderr),
    out,
    ready: /Preview ready/.test(out),
    readyAt,
    storefront: storefront === null ? null : new URL(storefront[1]!).origin,
    tmp,
    dirsSeen: [...seen].sort(),
    dirsWhenSignalled,
    dirsAfter: previewDirs(tmp),
    signalled,
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/** Waits, up to `ms`, for every pid to be gone; the ones still alive. */
async function stillAlive(pids: number[], ms = 5000): Promise<number[]> {
  const deadline = Date.now() + ms
  let left = pids.filter(alive)
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    left = left.filter(alive)
  }
  return left
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

/** What changed under a project since `before`, the three preview outputs and a new empty `-wal` aside. */
function projectChanges(before: Map<string, string>, root: string) {
  const after = treeOf(root)
  return {
    added: [...after]
      .filter(
        ([p, h]) =>
          !before.has(p) && !OUTPUTS.includes(p) && !(p.endsWith('-wal') && h === 'empty'),
      )
      .map(([p]) => p)
      .sort(),
    changed: [...after]
      .filter(([p, h]) => before.has(p) && before.get(p) !== h && !OUTPUTS.includes(p))
      .map(([p]) => p)
      .sort(),
    removed: [...before.keys()].filter((p) => !after.has(p)).sort(),
  }
}
const untouched = { added: [], changed: [], removed: [] }

function readReport(dir: string) {
  return JSON.parse(readFileSync(join(dir, OUTPUTS[0]!), 'utf8')) as { lighthouse?: Section | null }
}

/** The first product row and the first category row of the redirect map the preview wrote. */
function firstRows(dir: string) {
  const rows = parseCsv(readFileSync(join(dir, OUTPUTS[2]!), 'utf8'))
    .slice(1)
    .map(([from, to]) => ({ from: from!, to: to! }))
  return {
    product: rows.find((r) => r.to.startsWith('/product/'))!,
    category: rows.find((r) => r.to.startsWith('/category/'))!,
  }
}

/** The six URLs in the order each run measures them: home, product and category, source then preview. */
function sixUrls(sourceUrl: string, storefront: string, dir: string) {
  const { product, category } = firstRows(dir)
  const origin = new URL(sourceUrl).origin
  return {
    home: { source: `${origin}/`, preview: `${storefront}/` },
    product: { source: new URL(product.from, origin).href, preview: `${storefront}${product.to}` },
    category: {
      source: new URL(category.from, origin).href,
      preview: `${storefront}${category.to}`,
    },
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** The medians of what the stand-in gave `url`, metric by metric. */
function mediansGiven(starts: StartLine[], url: string): Median | null {
  const samples = starts.filter((s) => s.url === url && s.sample !== null).map((s) => s.sample!)
  if (samples.length === 0) return null
  return Object.fromEntries(
    METRICS.map((m) => [m, median(samples.flatMap((s) => (s[m] === null ? [] : [s[m]!])))]),
  ) as Median
}

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Whatever a failed case left running: every stand-in and its Chrome.
  for (const log of logs) {
    if (!existsSync(log)) continue
    for (const line of readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')) {
      const entry = JSON.parse(line) as Partial<StartLine>
      for (const pid of [entry.pid, entry.chromePid]) {
        if (pid === undefined) continue
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // gone
        }
      }
    }
  }
  await Promise.all(servers.splice(0).map((s) => s.close()))
  await Promise.all(upstreams.splice(0).map((u) => u.close()))
  for (const p of projects.splice(0)) p.remove()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(config: Record<string, unknown> = storeConfig()): string {
  const p = storeProject(config)
  projects.push(p)
  return p.dir
}

async function woo(opts: WooCommerceServerOptions = {}): Promise<WooCommerceServer> {
  const server = await startWooCommerceServer({ imagesPerProduct: 1, pages: true, ...opts })
  servers.push(server)
  return server
}

async function storefrontStandIn(): Promise<Upstream> {
  const stand = await upstream(scratchDir('preview-lighthouse-storefront-'))
  upstreams.push(stand)
  return stand
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

/** The source's page paths for every fixture product and category. */
function fixturePagePaths() {
  const categories = fixture('categories')
  const byId = new Map(categories.map((c) => [c['id'] as number, c]))
  const categoryPath = (c: Record<string, unknown>) => {
    const chain = [c['slug'] as string]
    let parent = Number(c['parent'] ?? 0)
    while (parent !== 0 && byId.has(parent)) {
      const up = byId.get(parent)!
      chain.unshift(up['slug'] as string)
      parent = Number(up['parent'] ?? 0)
    }
    return `/product-category/${chain.join('/')}/`
  }
  return {
    products: fixture('products').map(productPagePath),
    categories: categories.map(categoryPath),
  }
}

/** The source's page requests (not its API, not its images). */
function pageRequests(server: WooCommerceServer) {
  const images = new Set([...server.images.keys()].map((src) => new URL(src).pathname))
  return server.requests.filter((r) => !r.path.startsWith('/wp-json/') && !images.has(r.path))
}

const countBy = <T>(xs: T[], key: (x: T) => string) => {
  const out: Record<string, number> = {}
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1
  return out
}

// ─── AC-5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-5: the measurement plan, through the CLI', () => {
  let server: WooCommerceServer
  let stand: Upstream
  let lighthouse: ReturnType<typeof standIn>
  let dir: string
  let before: Map<string, string>
  let run: PreviewRun
  let urls: ReturnType<typeof sixUrls>
  let upstreamFrom = 0

  beforeAll(async () => {
    server = await woo()
    stand = await storefrontStandIn()
    lighthouse = standIn()
    dir = project()
    installLighthouse(dir)
    before = treeOf(dir)
    upstreamFrom = stand.requests.length

    run = await preview(
      [...source(server.url), '--lighthouse', '--lighthouse-runs', '3', '--keep'],
      {
        cwd: dir,
        env: {
          NYMBAL_STOREFRONT_ENTRY: stand.entry,
          CHROME_PATH: process.execPath,
          NYMBAL_LIGHTHOUSE_STAND_IN: lighthouse.plan,
          NYMBAL_LIGHTHOUSE_CLI: undefined,
        },
      },
    )
    if (run.ready && run.storefront !== null) urls = sixUrls(server.url, run.storefront, dir)
  }, 240_000)

  const order = () => PAGES.flatMap((page) => SIDES.map((side) => urls[page][side]))

  it('AC-5: the stand-in was run exactly 18 times, one at a time: runs 1, 2 and 3, each home, product and category, source then preview, on the pages the redirect map pairs', () => {
    expect(run.ready, run.out.slice(-3000)).toBe(true)
    const starts = lighthouse.starts()
    const ends = lighthouse.ends()

    expect(starts.map((s) => s.url)).toEqual([...order(), ...order(), ...order()])
    const endOf = (pid: number) => ends.find((e) => e.pid === pid)?.at ?? Infinity
    const overlapping = starts
      .slice(1)
      .filter((s, k) => s.at < endOf(starts[k]!.pid))
      .map((s) => s.url)
    expect(overlapping).toEqual([])
  })

  it('AC-5: every run has JSON output, the performance category only, no error reporting and headless Chrome; none sets a preset, form factor, throttling or screen emulation, and none carries the key or the secret', () => {
    expect(run.ready, run.out.slice(-3000)).toBe(true)
    const required = [
      /--output[= ]json\b/,
      /--only-categories[= ]performance\b/,
      /--no-enable-error-reporting\b/,
      /--headless=new\b/,
    ]
    const forbidden = /--preset|--form-factor|--throttling-method|--screenEmulation/

    const wrong = lighthouse.starts().flatMap((s) => {
      const line = s.argv.join(' ')
      return [
        ...required.filter((re) => !re.test(line)).map((re) => `${s.url}: no ${re.source}`),
        ...(forbidden.test(line) ? [`${s.url}: ${line}`] : []),
        ...[KEY, SECRET]
          .filter((secret) => line.includes(secret))
          .map(() => `${s.url}: a credential`),
      ]
    })

    expect(lighthouse.starts()).toHaveLength(18)
    expect(wrong).toEqual([])
  })

  it("AC-5: each source page and each preview page got exactly one warm-up GET, as Lighthouse's mobile Chrome asking for HTML, and every warm-up came before the first Lighthouse run", () => {
    expect(run.ready, run.out.slice(-3000)).toBe(true)
    expect(lighthouse.starts()).toHaveLength(18)
    const firstRun = Math.min(...lighthouse.starts().map((s) => s.at))
    const sourcePages = pageRequests(server)
    const previewPages = stand.requests.slice(upstreamFrom).filter((r) => r.userAgent === MOBILE_UA)
    const path = (url: string) => new URL(url).pathname

    expect(countBy(sourcePages, (r) => `${r.method} ${r.path}`)).toEqual(
      countBy(
        PAGES.map((p) => urls[p].source),
        (u) => `GET ${path(u)}`,
      ),
    )
    expect(
      sourcePages.filter(
        (r) => r.userAgent !== MOBILE_UA || !(r.accept ?? '').includes('text/html'),
      ),
    ).toEqual([])
    expect(countBy(previewPages, (r) => `${r.method} ${r.path}`)).toEqual(
      countBy(
        PAGES.map((p) => urls[p].preview),
        (u) => `GET ${path(u)}`,
      ),
    )
    expect(previewPages.filter((r) => !(r.accept ?? '').includes('text/html'))).toEqual([])
    expect([...sourcePages, ...previewPages].filter((r) => r.at >= firstRun)).toEqual([])
  })

  it("AC-5: the JSON report's lighthouse section holds, for each side, the median of what the stand-in gave that URL over three runs", () => {
    expect(run.ready, run.out.slice(-3000)).toBe(true)
    const starts = lighthouse.starts()
    const section = readReport(dir).lighthouse

    expect(section?.runs).toBe(3)
    expect(section?.lighthouseVersion).toBe(RECORDED.lighthouseVersion)
    expect(
      section?.pairs.map((p) => ({
        page: p.page,
        source: { url: p.source.url, median: p.source.median },
        preview: { url: p.preview.url, median: p.preview.median },
      })),
    ).toEqual(
      PAGES.map((page) => ({
        page,
        source: { url: urls[page].source, median: mediansGiven(starts, urls[page].source) },
        preview: { url: urls[page].preview, median: mediansGiven(starts, urls[page].preview) },
      })),
    )
  })

  it("AC-5: the Markdown ends with ## Lighthouse, and stdout prints each pair's median scores before Preview ready", () => {
    expect(run.ready, run.out.slice(-3000)).toBe(true)
    const markdown = readFileSync(join(dir, OUTPUTS[1]!), 'utf8')
    const starts = lighthouse.starts()
    const score = (url: string) => {
      const performance = mediansGiven(starts, url)?.performance
      return performance == null ? 'n/a' : String(Math.round(performance))
    }

    const headings = markdown.split('\n').filter((l) => l.startsWith('## '))
    expect(headings.at(-1)).toBe('## Lighthouse')
    const lines = run.stdout.split('\n').map((l) => l.trim())
    const readyAt = lines.indexOf('Preview ready')
    const expected = PAGES.map(
      (page) =>
        `lighthouse ${page}: source ${score(urls[page].source)} · preview ${score(urls[page].preview)}`,
    )
    const misplaced = expected.filter((l) => !(lines.indexOf(l) >= 0 && lines.indexOf(l) < readyAt))
    expect(misplaced, run.stdout.slice(-2000)).toEqual([])
  })

  it('AC-5: the kept directory holds the 18 results, one per page, side and run, and the project holds none of them', () => {
    expect(run.ready, run.out.slice(-3000)).toBe(true)
    expect(run.dirsAfter).toHaveLength(1)
    const kept = join(run.tmp, run.dirsAfter[0]!)

    expect(readdirSync(join(kept, 'lighthouse')).sort()).toEqual(
      PAGES.flatMap((page) =>
        SIDES.flatMap((side) => [1, 2, 3].map((i) => `${page}-${side}-${i}.json`)),
      ).sort(),
    )
    expect(projectChanges(before, dir)).toEqual(untouched)
  })
})

// ─── AC-6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-6: one failure stays one cell', () => {
  let server: WooCommerceServer
  let stand: Upstream
  let lighthouse: ReturnType<typeof standIn>
  let dir: string
  let run: PreviewRun
  let urls: ReturnType<typeof sixUrls>
  let section: Section | null | undefined
  let upstreamFrom = 0
  const ERROR = {
    code: 'ERRORED_DOCUMENT_REQUEST',
    message:
      'Lighthouse was unable to reliably load the page you requested. Make sure you are testing the correct URL and that the server is properly responding to all requests. (Status code: 404)',
  }

  beforeAll(async () => {
    const paths = fixturePagePaths()
    server = await woo({
      pageStatus: {
        ...Object.fromEntries(paths.products.map((p) => [p, 403])),
        ...Object.fromEntries(paths.categories.map((p) => [p, 'never' as const])),
      },
    })
    stand = await storefrontStandIn()
    const storefrontPort = await freePort()
    lighthouse = standIn([
      { port: Number(new URL(server.url).port), path: '/', answer: 'hang' },
      { port: storefrontPort, pathPrefix: '/category/', answer: { runtimeError: ERROR } },
    ])
    dir = project()
    installLighthouse(dir)
    upstreamFrom = stand.requests.length

    run = await preview(
      [
        ...source(server.url),
        '--lighthouse',
        '--lighthouse-runs',
        '1',
        '--lighthouse-timeout',
        '10',
        '--storefront-port',
        String(storefrontPort),
        '--keep',
      ],
      {
        cwd: dir,
        env: {
          NYMBAL_STOREFRONT_ENTRY: stand.entry,
          CHROME_PATH: process.execPath,
          NYMBAL_LIGHTHOUSE_STAND_IN: lighthouse.plan,
          NYMBAL_LIGHTHOUSE_CLI: undefined,
        },
      },
    )
    if (run.ready && run.storefront !== null) {
      urls = sixUrls(server.url, run.storefront, dir)
      section = readReport(dir).lighthouse
    }
  }, 240_000)

  const side = (page: (typeof PAGES)[number], which: (typeof SIDES)[number]) =>
    section!.pairs.find((p) => p.page === page)![which]
  const calledFor = (url: string) => lighthouse.starts().filter((s) => s.url === url)

  it('AC-6: the source product answering 403 is HTTP 403 with no runs and no median, and Lighthouse never ran on it', () => {
    expect(section, run.out.slice(-3000)).toBeTruthy()

    expect(side('product', 'source')).toEqual({
      url: urls.product.source,
      runs: [],
      median: null,
      reason: 'HTTP 403',
    })
    expect(calledFor(urls.product.source)).toEqual([])
  })

  it('AC-6: the source category that never answers its warm-up is cut at the run timeout, with no runs, and Lighthouse never ran on it', () => {
    expect(section, run.out.slice(-3000)).toBeTruthy()

    expect(side('category', 'source')).toEqual({
      url: urls.category.source,
      runs: [],
      median: null,
      reason: 'warm-up timed out after 10 s',
    })
    expect(calledFor(urls.category.source)).toEqual([])
  })

  it("AC-6: the preview category Lighthouse could not load carries Lighthouse's error and no median", () => {
    expect(section, run.out.slice(-3000)).toBeTruthy()
    const category = side('category', 'preview')

    expect(category.median).toBeNull()
    expect(category.reason).toContain('ERRORED_DOCUMENT_REQUEST')
  })

  it('AC-6: the source home whose Lighthouse hangs times out after 10 s, and neither the stand-in nor its Chrome is left running', async () => {
    expect(section, run.out.slice(-3000)).toBeTruthy()
    const home = side('home', 'source')
    const [hung] = calledFor(urls.home.source)

    expect([home.median, home.reason]).toEqual([null, 'timed out after 10 s'])
    expect(hung).toBeDefined()
    expect(await stillAlive([hung!.pid, hung!.chromePid])).toEqual([])
  })

  it('AC-6: the home and product preview pages carry the medians of what the stand-in gave them', () => {
    expect(section, run.out.slice(-3000)).toBeTruthy()
    const starts = lighthouse.starts()

    expect([side('home', 'preview').median, side('product', 'preview').median]).toEqual([
      mediansGiven(starts, urls.home.preview),
      mediansGiven(starts, urls.product.preview),
    ])
    expect(side('home', 'preview').median?.performance).toEqual(expect.any(Number))
  })

  it('AC-6: the preview still reaches Preview ready, within a bound set by the two timeouts, and exits 0 on SIGINT', () => {
    expect(run.ready, run.out.slice(-3000)).toBe(true)
    // The storefront's first request is the preview asking whether it is up.
    const storefrontUp = stand.requests[upstreamFrom]?.at ?? Number.NaN

    expect([run.code, run.signal]).toEqual([0, null])
    // A warm-up of 10 s and a run of 10 s plus 5 s to die, with room for the measured pages.
    expect(run.readyAt! - storefrontUp).toBeLessThan(50_000)
  })
})

// ─── AC-7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-7: refusals before the source is read', () => {
  let server: WooCommerceServer
  let stand: Upstream

  beforeAll(async () => {
    server = await woo()
    stand = await storefrontStandIn()
  })

  /** A project and environment as AC-5's: the stand-in installed, the storefront stand-in, Chrome found. */
  function setUp(install: ((dir: string) => void) | null = installLighthouse) {
    const dir = project()
    install?.(dir)
    const env: Record<string, string | undefined> = {
      NYMBAL_STOREFRONT_ENTRY: stand.entry,
      CHROME_PATH: process.execPath,
      NYMBAL_LIGHTHOUSE_STAND_IN: standIn().plan,
      NYMBAL_LIGHTHOUSE_CLI: undefined,
      npm_config_user_agent: undefined,
    }
    return { dir, env }
  }

  /**
   * A preview that should be refused: its exit, what reached the source, the preview directories made, the outputs
   * written, and whether one line of stderr names every one of `named`.
   */
  async function refusal(
    args: string[],
    dir: string,
    env: Record<string, string | undefined>,
    named: string[],
  ) {
    const from = server.requests.length
    const run = await preview([...source(server.url), ...args], {
      cwd: dir,
      env,
      timeoutMs: 60_000,
    })
    return {
      run,
      outcome: {
        exit: [run.code, run.ready],
        requests: server.requests.slice(from).map((r) => `${r.method} ${r.path}`),
        dirs: [...run.dirsSeen, ...run.dirsAfter],
        outputs: OUTPUTS.filter((f) => existsSync(join(dir, f))),
        named: run.stderr.split('\n').some((l) => named.every((n) => l.includes(n))),
      },
    }
  }
  /** Exit 1 before Preview ready, nothing asked of the source, no directory, no output, and the line that says why. */
  const REFUSED = { exit: [1, false], requests: [], dirs: [], outputs: [], named: true }

  it("AC-7: no lighthouse in a pnpm project: exits 1 with pnpm's install line and NYMBAL_LIGHTHOUSE_CLI, before any request", async () => {
    const { dir, env } = setUp(null)
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")

    const { run, outcome } = await refusal(['--lighthouse'], dir, env, [
      'pnpm add -D lighthouse@^12',
    ])

    expect(outcome, run.out.slice(-3000)).toEqual(REFUSED)
    expect(run.stderr).toContain('NYMBAL_LIGHTHOUSE_CLI')
  }, 60_000)

  it("AC-7: no lighthouse in an npm project: exits 1 with npm's install line, before any request", async () => {
    const { dir, env } = setUp(null)
    writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3 }\n')

    const { run, outcome } = await refusal(['--lighthouse'], dir, env, [
      'npm install -D lighthouse@^12',
    ])

    expect(outcome, run.out.slice(-3000)).toEqual(REFUSED)
    expect(run.stderr).not.toContain('pnpm add')
  }, 60_000)

  it('AC-7: Lighthouse 11.4.0 installed: exits 1 naming 11.4.0 and ^12, before any request', async () => {
    const { dir, env } = setUp((d) => installLighthouse(d, '11.4.0'))

    const { run, outcome } = await refusal(['--lighthouse'], dir, env, ['11.4.0', '^12'])

    expect(outcome, run.out.slice(-3000)).toEqual(REFUSED)
  }, 60_000)

  it('AC-7: CHROME_PATH naming a missing file: exits 1 naming CHROME_PATH and the path, before any request', async () => {
    const { dir, env } = setUp()
    const missing = join(scratchDir('no-chrome-'), `chrome-${randomBytes(4).toString('hex')}`)

    const { run, outcome } = await refusal(
      ['--lighthouse'],
      dir,
      { ...env, CHROME_PATH: missing },
      ['CHROME_PATH', missing],
    )

    expect(outcome, run.out.slice(-3000)).toEqual(REFUSED)
  }, 60_000)

  it('AC-7: --lighthouse with --api-only: exits 1 naming both flags, before any request', async () => {
    const { dir, env } = setUp()

    const { run, outcome } = await refusal(['--lighthouse', '--api-only'], dir, env, [
      '--lighthouse',
      '--api-only',
    ])

    expect(outcome, run.out.slice(-3000)).toEqual(REFUSED)
  }, 60_000)

  it('AC-7: --lighthouse-runs 0: exits 1 naming the flag, before any request', async () => {
    const { dir, env } = setUp()

    const { run, outcome } = await refusal(['--lighthouse', '--lighthouse-runs', '0'], dir, env, [
      '--lighthouse-runs',
    ])

    expect(outcome, run.out.slice(-3000)).toEqual(REFUSED)
  }, 60_000)

  it('AC-7: --lighthouse-timeout abc: exits 1 naming the flag, before any request', async () => {
    const { dir, env } = setUp()

    const { run, outcome } = await refusal(
      ['--lighthouse', '--lighthouse-timeout', 'abc'],
      dir,
      env,
      ['--lighthouse-timeout'],
    )

    expect(outcome, run.out.slice(-3000)).toEqual(REFUSED)
  }, 60_000)

  it('AC-7: NYMBAL_LIGHTHOUSE_CLI naming a missing file: exits 1 naming the variable and the path, before any request', async () => {
    const { dir, env } = setUp(null)
    const missing = join(scratchDir('no-lighthouse-'), 'lighthouse', 'cli', 'index.js')

    const { run, outcome } = await refusal(
      ['--lighthouse'],
      dir,
      { ...env, NYMBAL_LIGHTHOUSE_CLI: missing },
      ['NYMBAL_LIGHTHOUSE_CLI', missing],
    )

    expect(outcome, run.out.slice(-3000)).toEqual(REFUSED)
  }, 60_000)

  it("AC-7: in pnpm's layout, with CHROME_PATH unset and the chrome-launcher beside Lighthouse finding no Chrome, exits 1 with the Chrome message, before any request", async () => {
    const { dir, env } = setUp(installLighthousePnpm)

    const { run, outcome } = await refusal(
      ['--lighthouse'],
      dir,
      { ...env, CHROME_PATH: undefined },
      ['Chrome not found', 'CHROME_PATH'],
    )

    expect(outcome, run.out.slice(-3000)).toEqual(REFUSED)
  }, 60_000)
})

// ─── AC-8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("AC-8: the merchant's project, with Lighthouse", () => {
  let server: WooCommerceServer
  let stand: Upstream
  let dir: string
  let env: Record<string, string | undefined>
  let before: Map<string, string>
  const MERCHANT_FILES = [
    'nymbal.db',
    '.nymbal-migration.json',
    'nymbal-migration-report.md',
    'nymbal-import-plan.json',
  ]

  beforeAll(async () => {
    server = await woo({ customers: fixture('customers'), orders: fixture('orders') })
    stand = await storefrontStandIn()
    dir = project()
    installLighthouse(dir)
    env = {
      NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db'),
      NYMBAL_STOREFRONT_ENTRY: stand.entry,
      CHROME_PATH: process.execPath,
      NYMBAL_LIGHTHOUSE_CLI: undefined,
    }
    const run = (args: string[]) =>
      runCli(args, {
        cwd: dir,
        env: cliEnv({ NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db') }),
        timeoutMs: 120_000,
      })
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

  /** Every stand-in and Chrome stand-in pid a log names. */
  const pidsOf = (lighthouse: ReturnType<typeof standIn>) =>
    lighthouse.starts().flatMap((s) => [s.pid, s.chromePid])

  it("AC-8: stopped with SIGINT at Preview ready, every file of the merchant's is byte-identical, the temporary directory is gone, and no stand-in or its Chrome is alive", async () => {
    const lighthouse = standIn()

    const run = await preview([...source(server.url), '--lighthouse', '--lighthouse-runs', '1'], {
      cwd: dir,
      env: { ...env, NYMBAL_LIGHTHOUSE_STAND_IN: lighthouse.plan },
    })

    expect(run.ready, run.out.slice(-3000)).toBe(true)
    expect(lighthouse.starts()).toHaveLength(6)
    expect([run.code, run.signal]).toEqual([0, null])
    expect(projectChanges(before, dir)).toEqual(untouched)
    expect([run.dirsWhenSignalled.length, run.dirsAfter]).toEqual([1, []])
    expect(await stillAlive(pidsOf(lighthouse))).toEqual([])
  }, 200_000)

  it("AC-8: SIGINT on the first lighthouse: line, while that run hangs, exits 0 with the merchant's files byte-identical, the directory gone, the report's lighthouse null, and no stand-in or its Chrome alive", async () => {
    const lighthouse = standIn([
      { port: Number(new URL(server.url).port), path: '/', answer: 'hang' },
    ])

    const run = await preview([...source(server.url), '--lighthouse', '--lighthouse-runs', '1'], {
      cwd: dir,
      env: { ...env, NYMBAL_LIGHTHOUSE_STAND_IN: lighthouse.plan },
      at: /^lighthouse: /m,
    })

    expect(run.signalled, run.out.slice(-3000)).toBe(true)
    expect([run.code, run.signal, run.ready]).toEqual([0, null, false])
    expect(projectChanges(before, dir)).toEqual(untouched)
    expect([run.dirsWhenSignalled.length, run.dirsAfter]).toEqual([1, []])
    expect(readReport(dir).lighthouse).toBeNull()
    expect(await stillAlive(pidsOf(lighthouse))).toEqual([])
  }, 200_000)

  /** A flat Astro project whose `astro` is a stand-in: `build` writes its pid and argv to `record`, then `script`. */
  function buildProject(template: 'astro' | 'nextjs', script: string) {
    const root = project(storeConfig({}, template))
    installLighthouse(root)
    writeFileSync(
      join(root, template === 'astro' ? 'astro.config.mjs' : 'next.config.mjs'),
      'export default {}\n',
    )
    const record = join(scratchDir('preview-build-'), 'build.json')
    const bin = join(root, 'node_modules', '.bin', template === 'astro' ? 'astro' : 'next')
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(
      bin,
      `#!${process.execPath}
const { writeFileSync } = process.getBuiltinModule('node:fs')
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() }))
if (process.argv[2] !== 'build') process.exit(3)
${script}
`,
    )
    chmodSync(bin, 0o755)
    const readRecord = () =>
      existsSync(record)
        ? (JSON.parse(readFileSync(record, 'utf8')) as { pid: number; argv: string[]; cwd: string })
        : null
    return { root, readRecord, before: treeOf(root) }
  }

  it("AC-8: SIGTERM on 'storefront: building for production' stops the build, built into the preview's directory, before anything is removed: its pid is gone, the directory is gone and the project is byte-identical", async () => {
    const build = buildProject('astro', 'setTimeout(() => {}, 120_000)')
    const lighthouse = standIn()
    const built = () => {
      const record = build.readRecord()
      return record?.argv[0] === 'build' ? record : null
    }

    const run = await preview([...source(server.url), '--lighthouse', '--lighthouse-runs', '1'], {
      cwd: build.root,
      env: {
        CHROME_PATH: process.execPath,
        NYMBAL_LIGHTHOUSE_STAND_IN: lighthouse.plan,
        NYMBAL_LIGHTHOUSE_CLI: undefined,
        NYMBAL_STOREFRONT_ENTRY: undefined,
      },
      // Once the line is printed and the build has started, so the signal finds a build to stop.
      at: (text) => text.includes('storefront: building for production') && built() !== null,
      signal: 'SIGTERM',
    })

    expect(run.out, run.out.slice(-3000)).toContain('storefront: building for production')
    expect(run.signalled).toBe(true)
    const record = build.readRecord()
    expect(record?.argv[0]).toBe('build')
    const inline = record!.argv.find((a) => a.startsWith('--outDir='))
    const outDir =
      inline?.slice('--outDir='.length) ?? record!.argv[record!.argv.indexOf('--outDir') + 1] ?? ''
    expect(outDir.startsWith(join(run.tmp, run.dirsWhenSignalled[0] ?? '?'))).toBe(true)
    expect(await stillAlive([record!.pid])).toEqual([])
    expect(run.dirsAfter).toEqual([])
    expect(projectChanges(build.before, build.root)).toEqual(untouched)
  }, 200_000)

  it('AC-8: a production build exiting 1 ends the preview with exit 1, its last 40 lines on stderr, and both ports free', async () => {
    const build = buildProject(
      'astro',
      "for (let i = 1; i <= 50; i++) process.stdout.write('build line ' + i + '\\n')\nprocess.exit(1)",
    )
    const [apiPort, storefrontPort] = [await freePort(), await freePort()]

    const run = await preview(
      [
        ...source(server.url),
        '--lighthouse',
        '--port',
        String(apiPort),
        '--storefront-port',
        String(storefrontPort),
      ],
      {
        cwd: build.root,
        env: {
          CHROME_PATH: process.execPath,
          NYMBAL_LIGHTHOUSE_STAND_IN: standIn().plan,
          NYMBAL_LIGHTHOUSE_CLI: undefined,
          NYMBAL_STOREFRONT_ENTRY: undefined,
        },
      },
    )

    expect(build.readRecord()?.argv[0], run.out.slice(-3000)).toBe('build')
    expect([run.code, run.ready]).toEqual([1, false])
    const shown = [...run.stderr.matchAll(/^build line (\d+)$/gm)].map((m) => Number(m[1]))
    expect(shown).toEqual(Array.from({ length: 40 }, (_, i) => i + 11))
    expect([await portFree(apiPort), await portFree(storefrontPort)]).toEqual([true, true])
    expect(run.dirsAfter).toEqual([])
    expect(projectChanges(build.before, build.root)).toEqual(untouched)
  }, 200_000)

  it('AC-8: a Next build that leaves no .next-preview/BUILD_ID (a config without the dist-dir line) is refused with exit 1, and .next-preview is removed', async () => {
    const build = buildProject('nextjs', 'process.exit(0)')

    const run = await preview([...source(server.url), '--lighthouse'], {
      cwd: build.root,
      env: {
        CHROME_PATH: process.execPath,
        NYMBAL_LIGHTHOUSE_STAND_IN: standIn().plan,
        NYMBAL_LIGHTHOUSE_CLI: undefined,
        NYMBAL_STOREFRONT_ENTRY: undefined,
      },
    })

    expect(build.readRecord()?.argv[0], run.out.slice(-3000)).toBe('build')
    expect([run.code, run.ready]).toEqual([1, false])
    expect(run.stderr).toMatch(/\.next-preview|BUILD_ID/)
    expect(existsSync(join(build.root, '.next-preview'))).toBe(false)
    expect(run.dirsAfter).toEqual([])
  }, 200_000)
})
