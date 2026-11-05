import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCsv } from '../support/csv.js'
import { startWooCommerceServer, type WooCommerceServer } from '../support/woocommerce-server.js'

// `nymbal preview` (the project's bin, which `npx nymbal` runs) in the scaffolded store while its `nymbal dev` keeps running (scripts/scaffold-clean.sh sets the
// variables below), against the recorded GBP store, whose images are real PNGs a browser decodes. The preview is
// asked for dev's own ports and must pick others; its storefront is the project's template, served on the preview's
// API. Afterwards nothing of the project's has changed and dev serves what it served.
//
//   NYMBAL_SCAFFOLD_DIR  the scaffolded project directory
//   NYMBAL_STORE_URL     the storefront `nymbal dev` serves
//   NYMBAL_API_URL       the API it serves (default http://localhost:3001)

const SCAFFOLD_DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const STORE_URL = process.env['NYMBAL_STORE_URL']
if (!SCAFFOLD_DIR || !STORE_URL) {
  throw new Error(
    'The preview case needs NYMBAL_SCAFFOLD_DIR (the scaffolded project) and NYMBAL_STORE_URL (its running storefront). ' +
      'Run it through scripts/scaffold-clean.sh <astro|nextjs>, which scaffolds, starts `nymbal dev` and sets both.',
  )
}
const DIR: string = SCAFFOLD_DIR
const DEV_STORE: string = STORE_URL
const DEV_API = process.env['NYMBAL_API_URL'] ?? 'http://localhost:3001'
const OUTPUTS = ['nymbal-preview-report.json', 'nymbal-preview-report.md', 'nymbal-redirects.csv']

/**
 * Left out of the comparison: the frameworks' build output (.astro, .next), Vite's and other tools' caches under
 * node_modules, and the database the running `nymbal dev` owns and may write to at any moment.
 */
const NOT_COMPARED = [
  /^\.astro(\/|$)/,
  /^\.next(\/|$)/,
  /^node_modules\/\.(vite|cache)(\/|$)/,
  /^nymbal\.db(-wal|-shm)?$/,
]

interface Browser {
  newPage(): Promise<Page>
  close(): Promise<void>
}
interface Page {
  addInitScript(script: string): Promise<void>
  goto(url: string, opts: { waitUntil: 'load' }): Promise<{ status(): number } | null>
  evaluate<T>(fn: string): Promise<T>
}
const { chromium } = createRequire(fileURLToPath(new URL('../e2e/package.json', import.meta.url)))(
  '@playwright/test',
) as { chromium: { launch(): Promise<Browser> } }

/** Every file under `root` (symlinks not followed) by its path: SHA-256, `empty`, or `-> target` for a link. */
function treeOf(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const rel = relative(root, path)
      if (NOT_COMPARED.some((re) => re.test(rel)) || name.endsWith('-shm')) continue
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) files.set(rel, `-> ${readlinkSync(path)}`)
      else if (stat.isDirectory()) walk(path)
      else {
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

function changedSince(before: Map<string, string>, after: Map<string, string>) {
  return {
    added: [...after.keys()].filter((p) => !before.has(p) && !OUTPUTS.includes(p)).sort(),
    changed: [...after]
      .filter(([p, h]) => before.has(p) && before.get(p) !== h && !OUTPUTS.includes(p))
      .map(([p]) => p)
      .sort(),
    removed: [...before.keys()].filter((p) => !after.has(p)).sort(),
  }
}

/** The environment of a shell in the project: the suite runs under pnpm, and npx reads the package manager's agent. */
function projectEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of Object.keys(env)) {
    if (
      key === 'npm_config_user_agent' ||
      key === 'npm_execpath' ||
      key.startsWith('npm_lifecycle_')
    ) {
      delete env[key]
    }
    if (key.startsWith('VITEST')) delete env[key]
  }
  delete env['NYMBAL_SQLITE_PATH']
  return env
}

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

/** Whether nothing answers at `url` any more. */
const gone = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(5000) }).then(
    () => false,
    () => true,
  )

async function productSlugs(api: string): Promise<Set<string>> {
  const slugs = new Set<string>()
  let cursor: string | null = null
  do {
    const q: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
    const res = await fetch(`${api}/api/products?limit=100${q}`)
    const body = (await res.json()) as {
      data: { items: Array<{ slug: string }>; nextCursor: string | null }
    }
    for (const item of body.data.items) slugs.add(item.slug)
    cursor = body.data.nextCursor
  } while (cursor !== null)
  return slugs
}

/** The pids of `pid`'s direct children, none when it has none. */
function childrenOf(pid: number): number[] {
  const res = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  return res.stdout.split(/\s+/).filter(Boolean).map(Number)
}

/** SIGKILLs every process group led by one of `leaders`; a group already gone is skipped. */
function killGroups(leaders: number[]): void {
  for (const leader of leaders) {
    try {
      process.kill(-leader, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

const portOf = (url: string) =>
  Number(new URL(url).port || (new URL(url).protocol === 'https:' ? 443 : 80))

interface Live {
  home: number
  product: { to: string; status: number; holdsName: boolean }
  category: { to: string; status: number }
  images: Array<{ src: string; naturalWidth: number }>
  violations: string[]
}

describe('AC-10: the preview storefront beside a running nymbal dev', () => {
  let woo: WooCommerceServer
  let tmp: string
  let before: Map<string, string>
  let after: Map<string, string>
  let devSlugsBefore: Set<string>
  let devSlugsAfter: Set<string>
  let devHomeAfter: number
  let out = ''
  let urls: { api: string; storefront: string } | null = null
  let live: Live | null = null
  let liveError: string | null = null
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  let afterStop: { api: boolean; storefront: boolean; dirs: string[] } | null = null
  /** Seconds from spawn to Preview ready, to the SIGINT, to the bound's SIGKILL and to the exit. */
  const times: { ready?: number; sigint?: number; killed?: number; exit?: number } = {}
  /** The preview's children when it was ready: the storefront, which leads a process group of its own. */
  let storefrontGroups: number[] = []

  beforeAll(async () => {
    woo = await startWooCommerceServer({ recorded: 'store-a-gbp' })
    tmp = mkdtempSync(join(tmpdir(), 'scaffold-preview-tmpdir-'))
    devSlugsBefore = await productSlugs(DEV_API)
    before = treeOf(DIR)

    // The project's own bin, which `npx nymbal` runs: npx runs it under `sh -c`, and Linux's sh (dash) forks rather
    // than execs, so a SIGINT sent to npx never reaches the preview, and one sent to the group makes npm exit by the
    // signal whatever the preview's own exit code.
    const started = Date.now()
    const seconds = () => Math.round((Date.now() - started) / 100) / 10
    const child = spawn(
      join(DIR, 'node_modules', '.bin', 'nymbal'),
      [
        'preview',
        ...[
          '--source',
          'woocommerce',
          '--url',
          woo.url,
          '--key',
          'ck_scaffold',
          '--secret',
          'cs_scaffold',
        ],
        ...['--port', String(portOf(DEV_API)), '--storefront-port', String(portOf(DEV_STORE))],
      ],
      {
        cwd: DIR,
        env: projectEnv({ TMPDIR: tmp }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    )
    let triggered = false
    const onOutput = (chunk: Buffer) => {
      out += chunk.toString()
      if (triggered) return
      const m = /Preview ready[\s\S]*?(https?:\/\/[^\s'"]+)[\s\S]*?(https?:\/\/[^\s'"]+)/.exec(
        stripAnsi(out),
      )
      if (m === null) return
      triggered = true
      times.ready = seconds()
      urls = { api: m[1]!.replace(/\/+$/, ''), storefront: m[2]!.replace(/\/+$/, '') }
      storefrontGroups = childrenOf(child.pid!)
      void browse(urls)
        .then((l) => (live = l))
        .catch(
          (error: unknown) => (liveError = error instanceof Error ? error.message : String(error)),
        )
        .finally(() => {
          times.sigint = seconds()
          child.kill('SIGINT')
        })
    }
    child.stdout.on('data', onOutput)
    child.stderr.on('data', onOutput)
    // About 10 s from spawn to Preview ready on a CI runner and under a second to browse: this bound is reached only
    // by a preview that hangs.
    const timer = setTimeout(() => {
      times.killed = seconds()
      killGroups([child.pid!, ...storefrontGroups])
    }, 400_000)
    exit = await exited
    times.exit = seconds()
    clearTimeout(timer)
    // Probed before the group is killed: a storefront the preview left running still answers here.
    const printed = urls as { api: string; storefront: string } | null
    afterStop = {
      api: printed === null ? false : await gone(`${printed.api}/health`),
      storefront: printed === null ? false : await gone(printed.storefront),
      dirs: readdirSync(tmp).filter((n) => n.startsWith('nymbal-preview-')),
    }
    // Gone already when the preview stopped as it should; the storefront runs in a group of its own.
    killGroups([child.pid!, ...storefrontGroups])
    after = treeOf(DIR)
    devSlugsAfter = await productSlugs(DEV_API)
    devHomeAfter = (await fetch(DEV_STORE)).status
  }, 500_000)

  afterAll(async () => {
    killGroups(storefrontGroups)
    await woo?.close()
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
    for (const f of OUTPUTS) rmSync(join(DIR, f), { force: true })
  })

  /** What a shopper gets on the preview storefront: `/`, the first product and category redirect targets, an image. */
  async function browse(at: { api: string; storefront: string }): Promise<Live> {
    const rows = parseCsv(readFileSync(join(DIR, 'nymbal-redirects.csv'), 'utf8')).slice(1)
    const productTo = rows.find((r) => r[1]!.startsWith('/product/'))![1]!
    const categoryTo = rows.find((r) => r[1]!.startsWith('/category/'))![1]!
    const doc = (await (
      await fetch(`${at.api}/api/products/${productTo.slice('/product/'.length)}`)
    ).json()) as { data: { name: string } }
    const page = (path: string) => fetch(`${at.storefront}${path}`)
    const productPage = await page(productTo)
    const html = await productPage.text()

    // A product with an image, on the storefront, in a browser that reports what the page policy refuses.
    let withImage: string | null = null
    for (const [, to] of rows.filter((r) => r[1]!.startsWith('/product/'))) {
      const res = await fetch(`${at.api}/api/products/${to!.slice('/product/'.length)}`)
      const media = ((await res.json()) as { data: { media?: unknown[] } }).data.media ?? []
      if (media.length > 0) {
        withImage = to!
        break
      }
    }
    const browser = await chromium.launch()
    try {
      const tab = await browser.newPage()
      await tab.addInitScript(
        "window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI))",
      )
      await tab.goto(`${at.storefront}${withImage ?? productTo}`, { waitUntil: 'load' })
      const apiOrigin = new URL(at.api).origin
      // The gallery renders in its shadow root, which document.images does not reach: every open root is walked.
      const images = await tab.evaluate<Array<{ src: string; naturalWidth: number }>>(
        `(() => { const all = []; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el instanceof HTMLImageElement) all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }; walk(document); return all.filter((i) => i.currentSrc.startsWith(${JSON.stringify(apiOrigin)})).map((i) => ({ src: i.currentSrc, naturalWidth: i.naturalWidth })) })()`,
      )
      const violations = await tab.evaluate<string[]>('window.__violations')
      return {
        home: (await page('/')).status,
        product: {
          to: productTo,
          status: productPage.status,
          holdsName: html.includes(doc.data.name),
        },
        category: { to: categoryTo, status: (await page(categoryTo)).status },
        images,
        violations,
      }
    } finally {
      await browser.close()
    }
  }

  it("AC-10: the preview reaches Preview ready on ports other than dev's, though asked for dev's own", () => {
    expect(urls, out.slice(-3000)).not.toBe(null)
    const { api, storefront } = urls!
    const ports = [portOf(api), portOf(storefront)]
    expect(ports.filter((p) => [portOf(DEV_API), portOf(DEV_STORE)].includes(p))).toEqual([])
    expect(new Set(ports).size).toBe(2)
  })

  it("AC-10: the preview storefront answers 200 on /, on the first product redirect's target (holding the product's name) and on the first category redirect's target", () => {
    expect(live, liveError ?? out.slice(-3000)).not.toBe(null)
    const { home, product, category } = live!
    expect({
      home,
      product: [product.status, product.holdsName],
      category: category.status,
    }).toEqual({
      home: 200,
      product: [200, true],
      category: 200,
    })
  })

  it("AC-10: a product image from the preview's API loads on its storefront page, and the page policy refuses nothing", () => {
    expect(live, liveError ?? out.slice(-3000)).not.toBe(null)
    const { images, violations } = live!
    expect(images.length).toBeGreaterThan(0)
    expect(images.filter((i) => i.naturalWidth === 0).map((i) => i.src)).toEqual([])
    expect(violations).toEqual([])
  })

  it("AC-10: after SIGINT the preview exits 0, its API and storefront answer no more, its directory is gone, and no file of the project's changed", () => {
    // Seconds from spawn: no SIGINT means the browse ran out the bound; a SIGKILL long after the SIGINT, the stop hung.
    expect(exit, `${JSON.stringify(times)}\n${out.slice(-3000)}`).toEqual({ code: 0, signal: null })
    expect(afterStop).toEqual({ api: true, storefront: true, dirs: [] })
    expect(changedSince(before, after)).toEqual({ added: [], changed: [], removed: [] })
    expect(OUTPUTS.filter((f) => !existsSync(join(DIR, f)))).toEqual([])
  })

  it("AC-10: the running dev store still answers and serves none of the source's products it did not serve before", () => {
    expect(urls, out.slice(-3000)).not.toBe(null)
    const sourceSlugs = woo.products.map((p) => p.slug)
    expect(devHomeAfter).toBe(200)
    expect(sourceSlugs.filter((s) => devSlugsAfter.has(s) && !devSlugsBefore.has(s))).toEqual([])
  })
})
