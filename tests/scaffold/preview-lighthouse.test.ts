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
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWooCommerceServer, type WooCommerceServer } from '../support/woocommerce-server.js'

// `nymbal preview --lighthouse` in the scaffolded store while its `nymbal dev` keeps running
// (scripts/scaffold-clean.sh sets the variables below), against the recorded GBP store answering its pages too. First
// as a store developer meets it, through `npx nymbal` with no Lighthouse in the project; then through the project's
// own bin with the repository's Lighthouse 12 through NYMBAL_LIGHTHOUSE_CLI and a real headless Chrome (CHROME_PATH
// or the usual install), one run a page.
//
//   NYMBAL_SCAFFOLD_DIR  the scaffolded project directory
//   NYMBAL_STORE_URL     the storefront `nymbal dev` serves
//   NYMBAL_API_URL       the API it serves (default http://localhost:3001)

const SCAFFOLD_DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const STORE_URL = process.env['NYMBAL_STORE_URL']
if (!SCAFFOLD_DIR || !STORE_URL) {
  throw new Error(
    'The preview Lighthouse case needs NYMBAL_SCAFFOLD_DIR (the scaffolded project) and NYMBAL_STORE_URL (its running storefront). ' +
      'Run it through scripts/scaffold-clean.sh <astro|nextjs>, which scaffolds, starts `nymbal dev` and sets both.',
  )
}
const DIR: string = SCAFFOLD_DIR
const DEV_STORE: string = STORE_URL
const DEV_API = process.env['NYMBAL_API_URL'] ?? 'http://localhost:3001'
const OUTPUTS = ['nymbal-preview-report.json', 'nymbal-preview-report.md', 'nymbal-redirects.csv']
const REPO_LIGHTHOUSE = fileURLToPath(new URL('../../node_modules/lighthouse/', import.meta.url))
const LIGHTHOUSE_CLI = join(REPO_LIGHTHOUSE, 'cli', 'index.js')
const LIGHTHOUSE_VERSION = (
  JSON.parse(readFileSync(join(REPO_LIGHTHOUSE, 'package.json'), 'utf8')) as { version: string }
).version
const TEMPLATE: 'astro' | 'nextjs' =
  existsSync(join(DIR, 'next.config.mjs')) || existsSync(join(DIR, 'next.config.ts'))
    ? 'nextjs'
    : 'astro'

/** The install line for the scaffold's own package manager, from its lockfile (npx runs as npm too). */
const LOCKFILES: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm add'],
  ['yarn.lock', 'yarn add'],
  ['bun.lock', 'bun add'],
  ['bun.lockb', 'bun add'],
  ['package-lock.json', 'npm install'],
]
const INSTALL_LINE = `${LOCKFILES.find(([file]) => existsSync(join(DIR, file)))?.[1] ?? 'npm install'} -D lighthouse@^12`

/** Left out of the comparison, as in the preview's own scaffold case: build output, tool caches, dev's database. */
const NOT_COMPARED = [
  /^\.astro(\/|$)/,
  /^\.next(\/|$)/,
  /^node_modules(\/|$)/,
  /^nymbal\.db(-wal|-shm)?$/,
]

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

/**
 * A shell's environment in the project: no package manager agent and no Vitest from the suite running under pnpm,
 * then `extra`.
 */
function projectEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      key === 'npm_config_user_agent' ||
      key === 'npm_execpath' ||
      key.startsWith('npm_lifecycle_') ||
      key.startsWith('VITEST')
    ) {
      delete env[key]
    }
  }
  delete env['NYMBAL_SQLITE_PATH']
  delete env['NYMBAL_LIGHTHOUSE_CLI']
  return { ...env, ...extra }
}

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
const portOf = (url: string) =>
  Number(new URL(url).port || (new URL(url).protocol === 'https:' ? 443 : 80))

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

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

/** Seconds from spawn to Preview ready, to the SIGINT, to the bound's SIGKILL and to the exit. */
interface Times {
  ready?: number
  sigint?: number
  killed?: number
  exit?: number
}

interface Run<T> {
  code: number | null
  signal: NodeJS.Signals | null
  out: string
  stderr: string
  urls: { api: string; storefront: string } | null
  live: T | null
  liveError: string | null
  tmp: string
  times: Times
  /** The run's own group and its children's: the storefront, the build and Lighthouse each lead one. */
  groups: number[]
}

/**
 * About 75 s from spawn to the exit of the measured run on a laptop, the build and six Lighthouse runs included: this
 * bound is reached only by a preview that hangs, and stays well inside the hooks' timeouts.
 */
const BOUND_MS = 400_000

/**
 * `nymbal preview <args>` in the project with a TMPDIR of its own, asked for dev's own ports, through `npx nymbal` or
 * the project's own bin. At `Preview ready` it runs `whileUp`, then sends SIGINT and waits for the exit; a run that
 * ends first ends the wait. A SIGINT goes only to the project's bin: npx runs it under `sh -c`, and Linux's sh (dash)
 * forks rather than execs, so a SIGINT sent to npx never reaches the preview.
 */
async function preview<T>(
  via: 'npx' | 'bin',
  args: string[],
  extra: Record<string, string>,
  whileUp: (urls: { api: string; storefront: string }) => Promise<T>,
): Promise<Run<T>> {
  const tmp = mkdtempSync(join(tmpdir(), 'scaffold-lighthouse-tmpdir-'))
  scratch.push(tmp)
  const argv = [
    'preview',
    ...args,
    ...['--port', String(portOf(DEV_API)), '--storefront-port', String(portOf(DEV_STORE))],
  ]
  const started = Date.now()
  const seconds = () => Math.round((Date.now() - started) / 100) / 10
  const times: Times = {}
  const child = spawn(
    via === 'npx' ? 'npx' : join(DIR, 'node_modules', '.bin', 'nymbal'),
    via === 'npx' ? ['nymbal', ...argv] : argv,
    {
      cwd: DIR,
      env: projectEnv({ TMPDIR: tmp, ...extra }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let out = ''
  let stderr = ''
  let triggered = false
  let urls: { api: string; storefront: string } | null = null
  let live: T | null = null
  let liveError: string | null = null
  const groups = [child.pid!]
  runGroups.push(groups)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  )
  const onOutput = (chunk: Buffer) => {
    out += chunk.toString()
    if (triggered) return
    const m = /Preview ready[\s\S]*?(https?:\/\/[^\s'"]+)[\s\S]*?(https?:\/\/[^\s'"]+)/.exec(
      stripAnsi(out),
    )
    if (m === null) return
    triggered = true
    times.ready = seconds()
    const printed = { api: m[1]!.replace(/\/+$/, ''), storefront: m[2]!.replace(/\/+$/, '') }
    urls = printed
    groups.push(...childrenOf(child.pid!))
    void whileUp(printed)
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
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    onOutput(chunk)
  })
  const timer = setTimeout(() => {
    times.killed = seconds()
    // Read again while the preview is alive: a hang before Preview ready leaves a build or Lighthouse running.
    groups.push(...childrenOf(child.pid!))
    killGroups(groups)
  }, BOUND_MS)
  const { code, signal } = await exited
  times.exit = seconds()
  clearTimeout(timer)
  return {
    code,
    signal,
    out: stripAnsi(out),
    stderr: stripAnsi(stderr),
    urls,
    live,
    liveError,
    tmp,
    times,
    groups,
  }
}

const scratch: string[] = []
const servers: WooCommerceServer[] = []
/** Every run's groups, killed at the end whatever a run left behind. */
const runGroups: number[][] = []

afterAll(async () => {
  for (const groups of runGroups.splice(0)) killGroups(groups)
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const f of OUTPUTS) rmSync(join(DIR, f), { force: true })
})

const source = (url: string) => [
  '--source',
  'woocommerce',
  '--url',
  url,
  '--key',
  'ck_scaffold',
  '--secret',
  'cs_scaffold',
]

describe('AC-9: real Lighthouse on a scaffolded store', () => {
  it("AC-9: with no Lighthouse in the project, --lighthouse exits 1 with the install line for the project's package manager, before any request to the store", async () => {
    const woo = await startWooCommerceServer({ recorded: 'store-a-gbp', pages: true })
    servers.push(woo)

    const run = await preview('npx', [...source(woo.url), '--lighthouse'], {}, async () => null)

    expect([run.code, run.urls], `${JSON.stringify(run.times)}\n${run.out.slice(-3000)}`).toEqual([
      1,
      null,
    ])
    expect(run.stderr).toContain(INSTALL_LINE)
    expect(woo.requests).toEqual([])
  }, 600_000)

  describe('with the repository Lighthouse through NYMBAL_LIGHTHOUSE_CLI', () => {
    let woo: WooCommerceServer
    let before: Map<string, string>
    let devSlugsBefore: Set<string>
    let run: Run<{ production: boolean }>
    let afterStop: {
      ports: boolean[]
      nextPreview: boolean
      dirs: string[]
      tree: Map<string, string>
      devSlugs: Set<string>
    }

    beforeAll(async () => {
      woo = await startWooCommerceServer({ recorded: 'store-a-gbp', pages: true })
      servers.push(woo)
      devSlugsBefore = await productSlugs(DEV_API)
      before = treeOf(DIR)

      run = await preview(
        'bin',
        [...source(woo.url), '--lighthouse', '--lighthouse-runs', '1', '--keep'],
        { NYMBAL_LIGHTHOUSE_CLI: LIGHTHOUSE_CLI },
        async ({ storefront }) => {
          if (TEMPLATE === 'nextjs') {
            return { production: existsSync(join(DIR, '.next-preview', 'BUILD_ID')) }
          }
          const home = await (await fetch(`${storefront}/`)).text()
          return { production: home.length > 0 && !home.includes('/@vite/client') }
        },
      )
      const printed = run.urls
      afterStop = {
        ports:
          printed === null
            ? [false, false]
            : [await portFree(portOf(printed.api)), await portFree(portOf(printed.storefront))],
        nextPreview: existsSync(join(DIR, '.next-preview')),
        dirs: readdirSync(run.tmp).filter((n) => n.startsWith('nymbal-preview-')),
        tree: treeOf(DIR),
        devSlugs: await productSlugs(DEV_API),
      }
      // Gone already when the preview stopped as it should; probed above first, so one left running shows there.
      killGroups(run.groups)
    }, 500_000)

    const report = () =>
      JSON.parse(readFileSync(join(DIR, OUTPUTS[0]!), 'utf8')) as {
        lighthouse: {
          lighthouseVersion: string
          pairs: Array<{
            page: string
            source: { median: Record<string, number | null> | null; reason: string | null }
            preview: { median: Record<string, number | null> | null; reason: string | null }
          }>
        } | null
      }
    const kept = () => join(run.tmp, afterStop.dirs[0] ?? 'none')

    it("AC-9: the preview reaches Preview ready, measured by the repository's Lighthouse, with a performance score, LCP, CLS, TBT and transferred bytes on all six sides", () => {
      expect(run.urls, run.out.slice(-3000)).not.toBe(null)
      const section = report().lighthouse

      expect(section?.lighthouseVersion).toBe(LIGHTHOUSE_VERSION)
      const unmeasured = (section?.pairs ?? []).flatMap((p) =>
        (['source', 'preview'] as const).flatMap((side) => {
          const median = p[side].median
          const missing = ['performance', 'lcpMs', 'cls', 'tbtMs', 'bytes'].filter(
            (m) => median === null || median[m] === null || median[m] === undefined,
          )
          return missing.length === 0
            ? []
            : [`${p.page} ${side}: ${missing.join(', ')} (${p[side].reason})`]
        }),
      )
      expect(section?.pairs).toHaveLength(3)
      expect(unmeasured).toEqual([])
    })

    it('AC-9: the storefront measured is a production build, not the dev server', () => {
      expect(run.live, run.liveError ?? run.out.slice(-3000)).toEqual({ production: true })
    })

    it("AC-9: the preview product page's own result shows a /preview-media/ image loaded with status 200 under the page policy", () => {
      const file = join(kept(), 'lighthouse', 'product-preview-1.json')
      expect(existsSync(file), run.out.slice(-3000)).toBe(true)
      const lhr = JSON.parse(readFileSync(file, 'utf8')) as {
        audits: {
          'network-requests'?: { details?: { items?: Array<{ url: string; statusCode: number }> } }
        }
      }
      const media = (lhr.audits['network-requests']?.details?.items ?? []).filter((r) =>
        r.url.includes('/preview-media/'),
      )

      expect(media.filter((r) => r.statusCode === 200).length).toBeGreaterThanOrEqual(1)
      expect(media.filter((r) => r.statusCode !== 200)).toEqual([])
    })

    it("AC-9: after SIGINT both preview ports are free, .next-preview is gone, only the kept directory remains, holding the six results, no project file changed, and dev serves none of the source's products it did not serve before", () => {
      expect(run.urls, run.out.slice(-3000)).not.toBe(null)
      const results = existsSync(join(kept(), 'lighthouse'))
        ? readdirSync(join(kept(), 'lighthouse')).sort()
        : []

      expect(results).toEqual(
        ['home', 'product', 'category']
          .flatMap((page) => ['source', 'preview'].map((side) => `${page}-${side}-1.json`))
          .sort(),
      )

      // Seconds from spawn: no SIGINT means the run ran out the bound; a SIGKILL long after the SIGINT, the stop hung.
      expect(
        [run.code, run.signal],
        `${JSON.stringify(run.times)}\n${run.out.slice(-3000)}`,
      ).toEqual([0, null])
      expect(afterStop.ports).toEqual([true, true])
      expect(afterStop.nextPreview).toBe(false)
      expect(afterStop.dirs).toHaveLength(1)
      expect(run.out).toContain(afterStop.dirs[0]!)
      expect(changedSince(before, afterStop.tree)).toEqual({ added: [], changed: [], removed: [] })
      const sourceSlugs = woo.products.map((p) => p.slug)
      expect(
        sourceSlugs.filter((s) => afterStop.devSlugs.has(s) && !devSlugsBefore.has(s)),
      ).toEqual([])
    })
  })
})
