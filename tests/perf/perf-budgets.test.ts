import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { astroWithHeavyHome, heavyScriptGzipBytes } from './fixtures/heavy-home'

// AC-2 and AC-4: `pnpm perf:budgets` itself, spawned as CI's perf-budgets job runs it. Two runs, made once in
// beforeAll: the fixture run (the Astro template with a 300 KB script on `/`, `--template astro --dir <copy>`), then
// the real run (both templates, as committed), which is the last to write reports/perf-budgets.json, so the report
// is the real one.
// - AC-2: the fixture run fails on its page alone, and scriptBytes is the gzip sum of the page's scripts.
// - AC-4: every page is in the run and within budget, and Astro `/` ships no more script bytes than at 75989c8
//   (tests/perf/fixtures/astro-home-75989c8.json).
// The maintainers accepted the recently viewed list's bytes on `/`: the reference was 606e5aa (26,413 B) before it.
// Without Chrome the tests skip and say so (Lighthouse cannot run), except under CI, where they fail.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const REPORT = join(REPO, 'reports/perf-budgets.json')
const RUN_TIMEOUT_MS = 20 * 60_000
// CI's job adds its own arguments here (`--runs 5`); a local run measures as perf:budgets does by default.
const FROM_ENV = (process.env.NYMBAL_PERF_BUDGETS_ARGS ?? '').split(/\s+/).filter(Boolean)
const baseline = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/astro-home-75989c8.json', import.meta.url)),
    'utf8',
  ),
) as { commit: string; scriptBytes: number }

const LIMITS = { lcpMs: 2500, cls: 0.1, tbtMs: 200 } as const
// The Next home and listing, whose RSC flight payload repeats every server-rendered element's styles, are held to
// 3000 ms until those styles are sent once, as the budget file records (tests/tooling/perf-budgets-file.test.ts keeps
// that list to these two). Every other page has no exception.
const LCP_EXCEPTIONS_MS: Record<string, number> = {
  'nextjs / home': 3000,
  'nextjs / listing': 3000,
}
const PAGES = ['home', 'listing', 'product', 'cart', 'checkout'] as const
const TEMPLATES = ['astro', 'nextjs'] as const

interface Metrics {
  lcpMs: number
  cls: number
  tbtMs: number
  scriptBytes: number
}

interface ReportRow {
  template: string
  page: string
  url: string
  measured: Metrics
  budget: Metrics
  ok: boolean
}

interface Run {
  status: number | null
  output: string
  report: ReportRow[] | undefined
}

/** A Chrome Lighthouse can launch: CHROME_PATH, the macOS app, or a Chrome or Chromium on PATH. */
function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].flatMap((bin) =>
      (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, bin)),
    ),
  ]
  return candidates.find(
    (path): path is string => path !== undefined && path !== '' && existsSync(path),
  )
}

// Async, so the Vitest worker keeps answering its RPC while the runs take minutes: a blocking spawnSync timed the
// worker out and failed the suite with every test passing.
function perfBudgets(args: string[]): Promise<Run> {
  rmSync(REPORT, { force: true })
  return new Promise((resolve) => {
    const chunks: string[] = []
    const child = spawn('pnpm', ['perf:budgets', ...args, ...FROM_ENV], {
      cwd: REPO,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8').on('data', (c: string) => chunks.push(c))
    child.stderr.setEncoding('utf8').on('data', (c: string) => chunks.push(c))
    const timer = setTimeout(() => {
      chunks.push(`\nperf:budgets ${args.join(' ')} timed out after ${RUN_TIMEOUT_MS} ms`)
      child.kill('SIGTERM')
    }, RUN_TIMEOUT_MS)
    const finish = (status: number | null): void => {
      clearTimeout(timer)
      const report = existsSync(REPORT)
        ? (JSON.parse(readFileSync(REPORT, 'utf8')) as ReportRow[])
        : undefined
      resolve({ status, output: chunks.join(''), report })
    }
    child.on('error', (error) => {
      chunks.push(`\n${error.message}`)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

const tail = (output: string): string => output.split('\n').slice(-40).join('\n')
const row = (run: Run, template: string, page: string): ReportRow | undefined =>
  run.report?.find((r) => r.template === template && r.page === page)

const chrome = findChrome()
const NO_CHROME =
  'no Chrome (CHROME_PATH, the macOS app or google-chrome/chromium on PATH): Lighthouse cannot run'

let fixture: Run
let real: Run
let copy: string | undefined

beforeAll(async () => {
  // On a CI runner Chrome is part of the job: missing, it fails the suite rather than skipping the budgets.
  if (chrome === undefined && process.env.CI) throw new Error(NO_CHROME)
  if (chrome === undefined) return
  copy = astroWithHeavyHome(REPO)
  fixture = await perfBudgets(['--template', 'astro', '--dir', copy])
  real = await perfBudgets([])
})

// The copy's node_modules is a symlink: removing the copy removes the link, never the template's packages.
afterAll(() => {
  if (copy !== undefined) rmSync(copy, { recursive: true, force: true })
})

describe('AC-2: the run fails a slow page', () => {
  it('AC-2: with a 300 KB script on Astro /, perf:budgets exits 1 naming astro / home / scriptBytes, and no other page fails', (ctx) => {
    if (chrome === undefined) return ctx.skip(NO_CHROME)
    expect(fixture.status, tail(fixture.output)).toBe(1)
    expect(fixture.output).toContain('astro / home / scriptBytes')
    expect(fixture.report, 'reports/perf-budgets.json after the fixture run').toBeDefined()
    const failing = fixture.report!.filter((r) => !r.ok).map((r) => `${r.template} / ${r.page}`)
    expect(failing).toEqual(['astro / home'])
    const home = row(fixture, 'astro', 'home')!
    expect(home.measured.scriptBytes).toBeGreaterThan(home.budget.scriptBytes)
  })

  it('AC-2: the same template without the fixture passes, and the fixture adds its gzip size to home’s scriptBytes', (ctx) => {
    if (chrome === undefined) return ctx.skip(NO_CHROME)
    expect(real.report, tail(real.output)).toBeDefined()
    const astroRows = real.report!.filter((r) => r.template === 'astro')
    expect(astroRows.filter((r) => !r.ok).map((r) => r.page)).toEqual([])
    // scriptBytes is the gzip sum over the page's scripts: the fixture adds its own gzip size, not its raw size.
    const added =
      row(fixture, 'astro', 'home')!.measured.scriptBytes -
      row(real, 'astro', 'home')!.measured.scriptBytes
    const gzip = heavyScriptGzipBytes()
    expect(added).toBeGreaterThanOrEqual(Math.floor(gzip * 0.95))
    expect(added).toBeLessThanOrEqual(Math.ceil(gzip * 1.05) + 2048)
  })
})

describe('AC-4: the budgets hold', () => {
  it('AC-4: perf:budgets exits 0 for both templates on the five pages, each within LCP 2500 ms (nextjs home and listing at 3000), CLS 0.1, TBT 200 ms and its scriptBytes budget', (ctx) => {
    if (chrome === undefined) return ctx.skip(NO_CHROME)
    expect(real.status, tail(real.output)).toBe(0)
    expect(real.report, 'reports/perf-budgets.json after the real run').toBeDefined()
    const pages = real.report!.map((r) => `${r.template} / ${r.page}`).sort()
    expect(pages).toEqual(TEMPLATES.flatMap((t) => PAGES.map((p) => `${t} / ${p}`)).sort())
    for (const r of real.report!) {
      const at = `${r.template} / ${r.page}`
      expect(r.measured.lcpMs, `${at} lcpMs`).toBeLessThanOrEqual(
        LCP_EXCEPTIONS_MS[at] ?? LIMITS.lcpMs,
      )
      expect(r.measured.cls, `${at} cls`).toBeLessThanOrEqual(LIMITS.cls)
      expect(r.measured.tbtMs, `${at} tbtMs`).toBeLessThanOrEqual(LIMITS.tbtMs)
      expect(r.measured.scriptBytes, `${at} scriptBytes`).toBeLessThanOrEqual(r.budget.scriptBytes)
      expect(r.ok, at).toBe(true)
    }
  })

  it('AC-4: Astro / ships no more script bytes than at 75989c8', (ctx) => {
    if (chrome === undefined) return ctx.skip(NO_CHROME)
    const home = row(real, 'astro', 'home')
    expect(home, tail(real.output)).toBeDefined()
    expect(home!.measured.scriptBytes).toBeLessThanOrEqual(baseline.scriptBytes)
  })
})
