import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FULL_BUDGET_MS, plan, run, type RunResult, type StepSpec } from '../../scripts/gate'
import {
  astroWithHeavyHome,
  astroWithHomeScript,
  heavyScriptGzipBytes,
  scriptOfGzipSize,
} from './fixtures/heavy-home'

// AC-2 and AC-4: `pnpm perf:budgets` itself, spawned as CI's perf-budgets job runs it. Two runs, made once in
// beforeAll: the fixture run (the Astro template with a 300 KB script on `/`, `--template astro --dir <copy>`), then
// the real run (both templates, as committed), which is the last to write reports/perf-budgets.json, so the report
// is the real one.
// - AC-2: the fixture run fails on its page alone, and scriptBytes is the gzip sum of the page's scripts.
// - AC-4: every page is in the run and within budget, and Astro `/` ships no more script bytes than at 75989c8
//   (tests/perf/fixtures/astro-home-75989c8.json).
// The maintainers accepted the recently viewed list's bytes on `/`: the reference was 606e5aa (26,413 B) before it.
// Then the bytes runs, without Lighthouse (`--bytes`, reports/perf-bytes.json):
// - AC-5: gate:full's perf-bytes step, planned by plan() and run by the gate's runner in this checkout, is ok, and
//   gives each of the ten pages the scriptBytes the Lighthouse run measured;
// - AC-6: `--bytes` fails the fixture's home page alone, and fails a home page lifted above its 75989c8 reference
//   but kept under its budget on the reference.
// Without Chrome the tests skip and say so (Lighthouse cannot run), except under CI, where they fail.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const REPORT = join(REPO, 'reports/perf-budgets.json')
const BYTES_REPORT = join(REPO, 'reports/perf-bytes.json')
const BUDGETS = JSON.parse(readFileSync(join(REPO, 'perf-budgets.json'), 'utf8')) as Record<
  string,
  Record<string, { scriptBytes: number }>
>
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

/** A row of reports/perf-bytes.json. */
interface BytesRow {
  template: string
  page: string
  url: string
  scriptBytes: number
  ok: boolean
  failures: string[]
}

interface BytesRun {
  status: number | null
  output: string
  report: BytesRow[] | undefined
}

/** The perf-bytes step as gate:full plans it, the gate's runner's result, its log and the report it left. */
interface BytesStep {
  steps: StepSpec[]
  result: RunResult | undefined
  log: string
  report: BytesRow[] | undefined
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
  return spawnRun(args, REPORT) as Promise<Run>
}

function perfBytes(args: string[]): Promise<BytesRun> {
  return spawnRun(['--bytes', ...args], BYTES_REPORT) as Promise<BytesRun>
}

function readReport(file: string): unknown {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined
}

function spawnRun(args: string[], reportFile: string): Promise<Run | BytesRun> {
  rmSync(reportFile, { force: true })
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
      const report = readReport(reportFile) as ReportRow[] & BytesRow[]
      resolve({ status, output: chunks.join(''), report })
    }
    child.on('error', (error) => {
      chunks.push(`\n${error.message}`)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/** gate:full's perf-bytes step, run in this checkout by the gate's runner; a plan that has no such step says why. */
async function bytesStep(): Promise<BytesStep> {
  rmSync(BYTES_REPORT, { force: true })
  const logs: string[] = []
  try {
    const steps = plan({
      full: true,
      base: 'HEAD',
      changed: [],
      mutated: [],
      perfBytes: true,
      only: ['perf-bytes'],
      noBuild: true,
      artefactPresent: true,
    }).steps
    const result = await run(steps, {
      cwd: REPO,
      budgetMs: FULL_BUDGET_MS,
      log: (text) => logs.push(text),
    })
    return {
      steps,
      result,
      log: logs.join(''),
      report: readReport(BYTES_REPORT) as BytesRow[] | undefined,
    }
  } catch (error) {
    logs.push(`\n${error instanceof Error ? error.message : String(error)}`)
    return { steps: [], result: undefined, log: logs.join(''), report: undefined }
  }
}

const tail = (output: string): string => output.split('\n').slice(-40).join('\n')
const row = (run: Run, template: string, page: string): ReportRow | undefined =>
  run.report?.find((r) => r.template === template && r.page === page)
const bytesRow = (
  report: BytesRow[] | undefined,
  template: string,
  page: string,
): BytesRow | undefined => report?.find((r) => r.template === template && r.page === page)

const chrome = findChrome()
const NO_CHROME =
  'no Chrome (CHROME_PATH, the macOS app or google-chrome/chromium on PATH): Lighthouse cannot run'

let fixture: Run
let real: Run
let copy: string | undefined
let step: BytesStep
let heavyBytes: BytesRun
let lifted: BytesRun
let liftedCopy: string | undefined
/** AC-6's added script: its gzip size, and the Lighthouse run's Astro / bytes it is added to. */
let liftedBy: { home: number; gzipBytes: number }

beforeAll(async () => {
  // On a CI runner Chrome is part of the job: missing, it fails the suite rather than skipping the budgets.
  if (chrome === undefined && process.env.CI) throw new Error(NO_CHROME)
  if (chrome === undefined) return
  copy = astroWithHeavyHome(REPO)
  fixture = await perfBudgets(['--template', 'astro', '--dir', copy])
  real = await perfBudgets([])
  step = await bytesStep()
  heavyBytes = await perfBytes(['--template', 'astro', '--dir', copy])
  // A script whose gzip size lands Astro / between its reference and its budget, from the bytes Lighthouse measured.
  const home = row(real, 'astro', 'home')?.measured.scriptBytes ?? Number.NaN
  const budget = BUDGETS.astro?.home?.scriptBytes ?? Number.NaN
  const target = Math.floor((Math.max(home, baseline.scriptBytes) + budget) / 2) - home
  const sized = scriptOfGzipSize(target)
  liftedBy = { home, gzipBytes: sized.gzipBytes }
  liftedCopy = astroWithHomeScript(REPO, 'perf-fixture-lift.js', sized.script)
  lifted = await perfBytes(['--template', 'astro', '--dir', liftedCopy])
})

// The copy's node_modules is a symlink: removing the copy removes the link, never the template's packages.
afterAll(() => {
  for (const dir of [copy, liftedCopy])
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
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

describe('AC-5: the perf-bytes step measures what Lighthouse does', () => {
  it('AC-5: the step gate:full plans runs ok, and gives each of the ten pages the scriptBytes the Lighthouse run measured', (ctx) => {
    if (chrome === undefined) return ctx.skip(NO_CHROME)
    expect(
      step.steps.map((s) => [s.name, s.skip]),
      step.log,
    ).toEqual([['perf-bytes', undefined]])
    expect(
      step.result?.steps.map((s) => [s.name, s.status]),
      tail(step.log),
    ).toEqual([['perf-bytes', 'ok']])
    expect(real.report, tail(real.output)).toBeDefined()
    const pages = (step.report ?? []).map((r) => `${r.template} / ${r.page}`).sort()
    expect(pages, tail(step.log)).toEqual(
      TEMPLATES.flatMap((t) => PAGES.map((p) => `${t} / ${p}`)).sort(),
    )
    for (const r of step.report ?? []) {
      const at = `${r.template} / ${r.page}`
      expect(r.ok, at).toBe(true)
      expect(r.scriptBytes, `${at} scriptBytes`).toBe(
        row(real, r.template, r.page)?.measured.scriptBytes,
      )
    }
    expect(bytesRow(step.report, 'astro', 'home')?.scriptBytes).toBeLessThanOrEqual(
      baseline.scriptBytes,
    )
  })
})

describe('AC-6: --bytes fails what CI fails', () => {
  it('AC-6: with a 300 KB script on Astro /, --bytes exits 1 naming astro / home / scriptBytes, and no other page fails', (ctx) => {
    if (chrome === undefined) return ctx.skip(NO_CHROME)
    expect(heavyBytes.output, tail(heavyBytes.output)).toMatch(
      /^FAIL astro \/ home \/ scriptBytes: measured \d+, budget \d+$/m,
    )
    expect(heavyBytes.status, tail(heavyBytes.output)).toBe(1)
    const failing = (heavyBytes.report ?? []).filter((r) => !r.ok).map((r) => r.page)
    expect(failing, tail(heavyBytes.output)).toEqual(['home'])
    expect(bytesRow(heavyBytes.report, 'astro', 'home')?.scriptBytes).toBeGreaterThan(
      BUDGETS.astro?.home?.scriptBytes ?? Number.POSITIVE_INFINITY,
    )
  })

  it('AC-6: a script that lifts Astro / above its 75989c8 reference but not over its budget fails on the reference alone', (ctx) => {
    if (chrome === undefined) return ctx.skip(NO_CHROME)
    const budget = BUDGETS.astro?.home?.scriptBytes ?? Number.NaN
    // The fixture's own sizing: H < H + g <= budget.
    expect(liftedBy.home + liftedBy.gzipBytes).toBeGreaterThan(liftedBy.home)
    expect(liftedBy.home + liftedBy.gzipBytes).toBeLessThanOrEqual(budget)
    const reference = new RegExp(
      `^FAIL astro / home / scriptBytes: measured \\d+, reference ${baseline.scriptBytes} at ${baseline.commit}$`,
      'm',
    )
    expect(lifted.output, tail(lifted.output)).toMatch(reference)
    expect(lifted.output).not.toMatch(/^FAIL astro \/ home \/ scriptBytes: measured \d+, budget/m)
    expect(lifted.status, tail(lifted.output)).toBe(1)
    const home = bytesRow(lifted.report, 'astro', 'home')
    expect(home?.scriptBytes).toBeGreaterThan(baseline.scriptBytes)
    expect(home?.scriptBytes).toBeLessThanOrEqual(budget)
  })
})
