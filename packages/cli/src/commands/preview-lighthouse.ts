import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  readLighthouseResult,
  summariseSide,
  type LighthousePair,
  type LighthouseSample,
  type LighthouseSide,
  type PlannedPair,
} from '@nymbalhq/importers'
import { installLine } from '@nymbalhq/platform'
import { isFlatScaffold, type TemplateName } from '../utils/template-runner.js'

// `nymbal preview --lighthouse`: the project's Lighthouse CLI, spawned once per page and run, against the source's
// pages and a production build of the project's storefront. Lighthouse is an optional peer, never imported.

/** The user agent Lighthouse 12 emulates on mobile: the warm-up asks as the measured browser will. */
export const LIGHTHOUSE_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36'
const WARM_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
const CHROME_FLAGS = '--headless=new --no-sandbox --disable-dev-shm-usage'
/** After SIGINT, how long Lighthouse gets to close its Chrome before its group is killed. */
const KILL_AFTER_MS = 5000
const BUILD_TAIL_LINES = 40

const isFile = (path: string) => existsSync(path) && statSync(path).isFile()

export interface ResolvedLighthouse {
  cli: string
  version: string | null
}

/** The Lighthouse CLI the preview spawns: NYMBAL_LIGHTHOUSE_CLI, or the project's own `lighthouse@^12`. */
export function resolveLighthouse(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): ResolvedLighthouse | { error: string } {
  const custom = env['NYMBAL_LIGHTHOUSE_CLI']
  if (custom !== undefined && custom.trim() !== '') {
    const cli = resolve(projectRoot, custom)
    if (!isFile(cli)) return { error: `NYMBAL_LIGHTHOUSE_CLI=${custom} does not exist` }
    return { cli, version: null }
  }
  let manifest: string
  try {
    manifest = createRequire(join(projectRoot, 'package.json')).resolve('lighthouse/package.json')
  } catch {
    return {
      error: [
        `Lighthouse is not installed in this project. Install it with: ${installLine(['-D', 'lighthouse@^12'], env, projectRoot)}`,
        'Or set NYMBAL_LIGHTHOUSE_CLI to the lighthouse/cli/index.js of an install elsewhere.',
      ].join('\n'),
    }
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
    version?: string
    bin?: string | Record<string, string>
  }
  const version = pkg.version ?? 'unknown'
  if (version.split('.')[0] !== '12') {
    return { error: `Lighthouse ${version} is installed; nymbal preview --lighthouse needs ^12` }
  }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['lighthouse']
  if (bin === undefined)
    return { error: `Lighthouse ${version} at ${manifest} has no lighthouse bin` }
  return { cli: join(dirname(manifest), bin), version }
}

/**
 * Whether Chrome can be found, as the Lighthouse run will look for it: CHROME_PATH, or the chrome-launcher beside that
 * Lighthouse. A Lighthouse with no chrome-launcher beside it is not checked; each run then reports its own failure.
 */
export async function checkChrome(
  lighthouse: { cli: string },
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const given = env['CHROME_PATH']
  if (given !== undefined && given !== '') {
    return isFile(given) ? null : `Chrome not found: CHROME_PATH=${given} does not exist`
  }
  let launcher: { getChromePath: () => string }
  try {
    const path = createRequire(realpathSync(lighthouse.cli)).resolve('chrome-launcher')
    launcher = (await import(pathToFileURL(path).href)) as typeof launcher
  } catch {
    return null
  }
  try {
    launcher.getChromePath()
    return null
  } catch {
    return 'Chrome not found: install Google Chrome or Chromium, or set CHROME_PATH'
  }
}

/** SIGINT, so Lighthouse closes its Chrome; its process group is killed if it has not exited within 5 s. */
export async function stopLighthouse(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  child.kill('SIGINT')
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // the group is gone
    }
  }, KILL_AFTER_MS)
  await exited
  clearTimeout(timer)
}

export interface RunOptions {
  outputPath: string
  timeoutMs: number
  /** The running child while it runs, then null: what a stopping preview stops. */
  onChild?: (child: ChildProcess | null) => void
}

/** One Lighthouse run of `url`, mobile and simulated as Lighthouse defaults, its result read from `outputPath`. */
export function runLighthouse(
  cli: string,
  url: string,
  { outputPath, timeoutMs, onChild }: RunOptions,
): Promise<LighthouseSample> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        url,
        '--output=json',
        `--output-path=${outputPath}`,
        '--only-categories=performance',
        '--no-enable-error-reporting',
        '--quiet',
        `--chrome-flags=${CHROME_FLAGS}`,
      ],
      { cwd: dirname(outputPath), detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    onChild?.(child)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void stopLighthouse(child)
    }, timeoutMs)
    const finish = (sample: LighthouseSample) => {
      clearTimeout(timer)
      onChild?.(null)
      done(sample)
    }
    child.once('error', (err) => finish({ ok: false, reason: err.message }))
    child.once('exit', (code, signal) => {
      if (timedOut) {
        finish({ ok: false, reason: `timed out after ${Math.round(timeoutMs / 1000)} s` })
        return
      }
      readFile(outputPath, 'utf8')
        .then((text) => finish(readLighthouseResult(JSON.parse(text))))
        .catch(() => {
          const last = stderr
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '')
            .at(-1)
          finish({ ok: false, reason: last ?? `exit ${code ?? signal}` })
        })
    })
  })
}

/** One unmeasured GET, as Lighthouse's mobile Chrome asks for a page: why the side cannot be measured, or null. */
async function warmUp(url: string, timeoutMs: number, warm: typeof fetch): Promise<string | null> {
  try {
    const res = await warm(url, {
      headers: { 'user-agent': LIGHTHOUSE_MOBILE_UA, accept: WARM_ACCEPT },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    await res.body?.cancel().catch(() => undefined)
    return res.status >= 400 ? `HTTP ${res.status}` : null
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return `warm-up timed out after ${Math.round(timeoutMs / 1000)} s`
    }
    if (err instanceof Error) return err.cause instanceof Error ? err.cause.message : err.message
    return String(err)
  }
}

export interface MeasureOptions {
  cli: string
  runs: number
  timeoutMs: number
  /** The preview's directory: results go to `<dir>/lighthouse/<page>-<side>-<i>.json`. */
  dir: string
  run?: typeof runLighthouse
  warm?: typeof fetch
  /** True once the preview is stopping: no further run starts. */
  stopped?: () => boolean
  onChild?: (child: ChildProcess | null) => void
  print?: (line: string) => void
}

const SIDES = ['source', 'preview'] as const

/**
 * Every pair's sides, measured comparably: each URL warmed once first, then run i of every side in turn (home,
 * product, category; source then preview), one Lighthouse at a time.
 */
export async function measurePairs(
  pairs: PlannedPair[],
  {
    cli,
    runs,
    timeoutMs,
    dir,
    run = runLighthouse,
    warm = fetch,
    stopped = () => false,
    onChild,
    print = (line) => process.stdout.write(`${line}\n`),
  }: MeasureOptions,
): Promise<LighthousePair[]> {
  const refused = new Map<string, string>()
  for (const pair of pairs) {
    for (const side of SIDES) {
      const url = pair[side]
      if (url === null || stopped()) continue
      const reason = await warmUp(url, timeoutMs, warm)
      if (reason !== null) refused.set(`${pair.page}-${side}`, reason)
    }
  }

  const resultsDir = join(dir, 'lighthouse')
  await mkdir(resultsDir, { recursive: true })
  const samples = new Map<string, LighthouseSample[]>()
  for (let i = 1; i <= runs; i++) {
    for (const pair of pairs) {
      for (const side of SIDES) {
        const key = `${pair.page}-${side}`
        const url = pair[side]
        if (url === null || refused.has(key) || stopped()) continue
        print(`lighthouse: ${pair.page} ${side} ${i}/${runs}`)
        const sample = await run(cli, url, {
          outputPath: join(resultsDir, `${key}-${i}.json`),
          timeoutMs,
          ...(onChild !== undefined && { onChild }),
        })
        samples.set(key, [...(samples.get(key) ?? []), sample])
      }
    }
  }

  const sideOf = (pair: PlannedPair, side: (typeof SIDES)[number]): LighthouseSide => {
    const url = pair[side]
    const reason = url === null ? pair.reason : refused.get(`${pair.page}-${side}`)
    if (reason !== undefined) return { url, runs: [], median: null, reason }
    return summariseSide(url, samples.get(`${pair.page}-${side}`) ?? [])
  }
  return pairs.map((pair) => ({
    page: pair.page,
    source: sideOf(pair, 'source'),
    preview: sideOf(pair, 'preview'),
  }))
}

/** `lighthouse <page>: source <score | n/a> · preview <score | n/a>` for each pair. */
export function scoreLines(pairs: LighthousePair[]): string[] {
  const score = (side: LighthouseSide) => {
    const performance = side.median?.performance
    return performance === null || performance === undefined
      ? 'n/a'
      : String(Math.round(performance))
  }
  return pairs.map(
    (p) => `lighthouse ${p.page}: source ${score(p.source)} · preview ${score(p.preview)}`,
  )
}

// ─── The production storefront ────────────────────────────────────────────────────────────────────────────────────

export interface PreviewStorefront {
  template: TemplateName
  /** Where the framework builds and runs: the project root of a flat scaffold, else its template package. */
  cwd: string
  /** The framework's CLI, or null when NYMBAL_STOREFRONT_ENTRY stands in for the storefront. */
  bin: string | null
  /** NYMBAL_STOREFRONT_ENTRY, resolved: run with node in place of a build. */
  entry: string | null
}

/** Where the production storefront is built, and whether its framework is installed there. */
export function planPreviewStorefront(
  projectRoot: string,
  template: TemplateName,
  env: NodeJS.ProcessEnv,
): PreviewStorefront | { error: string } {
  const cwd = isFlatScaffold(projectRoot, template)
    ? projectRoot
    : join(projectRoot, 'templates', template)
  const given = env['NYMBAL_STOREFRONT_ENTRY']
  if (given !== undefined && given.trim() !== '') {
    return { template, cwd: projectRoot, bin: null, entry: resolve(projectRoot, given) }
  }
  const name = template === 'astro' ? 'astro' : 'next'
  const bin = join(cwd, 'node_modules', '.bin', name)
  if (!existsSync(bin)) {
    return {
      error: `Cannot find ${name} in ${join(cwd, 'node_modules', '.bin')}: install the storefront's dependencies, then run nymbal preview --lighthouse again`,
    }
  }
  return { template, cwd, bin, entry: null }
}

/** Where Astro writes the preview's build: inside the preview's directory, never the project's `dist/`. */
const astroOut = (dir: string) => join(dir, 'storefront')

/**
 * The production build, into the preview's directory (Astro) or NYMBAL_NEXT_DIST_DIR (Next). A failed build prints its
 * last 40 lines to stderr and throws.
 */
export async function buildPreviewStorefront(
  storefront: PreviewStorefront,
  {
    dir,
    env,
    onChild,
    stopped,
  }: {
    dir: string
    env: NodeJS.ProcessEnv
    onChild: (c: ChildProcess) => void
    stopped: () => boolean
  },
): Promise<void> {
  if (storefront.bin === null) return
  if (storefront.template === 'astro') {
    // The server Astro writes imports its packages by name: outside the project, they resolve through this link.
    await symlink(join(storefront.cwd, 'node_modules'), join(dir, 'node_modules'), 'dir')
  }
  // A stop that began while the files were read or the link made has already passed the build it would stop.
  if (stopped()) return
  const args = storefront.template === 'astro' ? ['build', '--outDir', astroOut(dir)] : ['build']
  const child = spawn(storefront.bin, args, {
    cwd: storefront.cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onChild(child)
  const tail: string[] = []
  let partial = ''
  const collect = (chunk: Buffer) => {
    const lines = (partial + chunk.toString()).split(/\r?\n/)
    partial = lines.pop() ?? ''
    tail.push(...lines)
    if (tail.length > BUILD_TAIL_LINES) tail.splice(0, tail.length - BUILD_TAIL_LINES)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const { code, signal, error } = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    error?: Error
  }>((done) => {
    child.once('error', (err) => done({ code: null, signal: null, error: err }))
    child.once('close', (c, s) => done({ code: c, signal: s }))
  })
  if (partial !== '') tail.push(partial)
  if (error !== undefined)
    throw new Error(`The storefront's production build could not start: ${error.message}`)
  if (code !== 0) {
    process.stderr.write(`${tail.slice(-BUILD_TAIL_LINES).join('\n')}\n`)
    throw new Error(`The storefront's production build exited ${code ?? signal}`)
  }
  if (storefront.template === 'nextjs') {
    const buildId = join(storefront.cwd, env['NYMBAL_NEXT_DIST_DIR'] ?? '.next', 'BUILD_ID')
    if (!existsSync(buildId)) {
      throw new Error(
        `The Next.js build left no ${buildId}: next.config must set distDir from NYMBAL_NEXT_DIST_DIR, as the template's does`,
      )
    }
  }
}

/** The built storefront, served as `nymbal start` serves it, on HOST and PORT from `env`. */
export function startPreviewStorefront(
  storefront: PreviewStorefront,
  { dir, port, env }: { dir: string; port: number; env: NodeJS.ProcessEnv },
): ChildProcess {
  const options = { cwd: storefront.cwd, env, stdio: 'inherit', detached: true } as const
  if (storefront.entry !== null) return spawn(process.execPath, [storefront.entry], options)
  if (storefront.template === 'astro') {
    return spawn(process.execPath, [join(astroOut(dir), 'server', 'entry.mjs')], options)
  }
  return spawn(storefront.bin!, ['start', '-H', '127.0.0.1', '-p', String(port)], options)
}
