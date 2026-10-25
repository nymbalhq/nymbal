import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { e2eReporters } from '../e2e/support/reporters'

// The gate's E2E steps run with retries, so a test that fails half the time passes as "flaky" and the run stays
// green (a Next test failed 3 of 6 runs with --retries=0 while every merge gate passed). Under CI each target's run
// writes a JSON report to reports/e2e-<target>.json at the repository root, where the merge gate reads the tests
// that passed only on a retry. The config is evaluated in a child with a run's environment, as Playwright reads it;
// the report's shape comes from a real run over a fixture spec that fails its first attempt only.

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const PLAYWRIGHT = join(REPO, 'tests/e2e/node_modules/.bin/playwright')
const E2E_DIR = join(REPO, 'tests/e2e')
const CONFIG_URL = pathToFileURL(join(E2E_DIR, 'playwright.config.ts')).href
const FIXTURE_CONFIG = join(REPO, 'tests/e2e/fixtures/flaky-report/playwright.config.ts')

const PRINT = `import(process.env.NYMBAL_TEST_CONFIG_URL).then((m) => {
  process.stdout.write('\\n' + JSON.stringify(m.default.reporter ?? null) + '\\n')
})`
const CONFIG_ENV = ['CI', 'GITHUB_ACTIONS', 'NYMBAL_E2E_TARGET']

async function reporterOf(env: Record<string, string>): Promise<unknown> {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONFIG_ENV) delete base[key]
  const { stdout } = await exec(TSX, ['--eval', PRINT], {
    cwd: E2E_DIR,
    env: { ...base, ...env, NYMBAL_TEST_CONFIG_URL: CONFIG_URL },
  })
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? 'null') as unknown
}

type Result = { status: string; retry: number }
type TestEntry = { projectName: string; status: string; results: Result[] }
type Spec = { title: string; file: string; tests: TestEntry[] }
type Suite = { specs: Spec[]; suites?: Suite[] }
type Report = {
  config: { rootDir: string }
  suites: Suite[]
  stats: { expected: number; unexpected: number; flaky: number; skipped: number }
}

const specsOf = (suites: Suite[]): Spec[] =>
  suites.flatMap((s) => [...s.specs, ...specsOf(s.suites ?? [])])

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('an E2E run under CI writes a JSON report per target beside the GitHub annotations', () => {
  it('the suite config, evaluated with CI=1 and a target, reports to reports/e2e-<target>.json at the repository root; by hand it lists', async () => {
    expect(await reporterOf({ CI: '1', NYMBAL_E2E_TARGET: 'astro' })).toEqual(
      e2eReporters(true, 'astro'),
    )
    expect(e2eReporters(true, 'astro')).toEqual([
      ['github'],
      ['json', { outputFile: join(REPO, 'reports/e2e-astro.json') }],
    ])
    expect(await reporterOf({ CI: '1', NYMBAL_E2E_TARGET: 'nextjs-custom' })).toEqual(
      e2eReporters(true, 'nextjs-custom'),
    )
    expect(await reporterOf({})).toBe('list')
  })

  it('a fixture spec that fails its first attempt only: the run is green, and the report alone says flaky, with the failed and the passed attempt', async () => {
    const reports = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-e2e-reports-')))
    dirs.push(reports)
    const { stdout } = await exec(PLAYWRIGHT, ['test', '--config', FIXTURE_CONFIG], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, NYMBAL_FIXTURE_REPORTS: reports, CI: '' },
    })
    const report = JSON.parse(readFileSync(join(reports, 'e2e-fixture.json'), 'utf8')) as Report
    expect(report.stats, stdout).toMatchObject({ expected: 1, unexpected: 0, flaky: 1 })
    const specs = specsOf(report.suites)
    const flaky = specs.find((s) => s.title === 'passes only on a retry')
    const steady = specs.find((s) => s.title === 'passes first time')
    expect(flaky?.tests.map((t) => t.status)).toEqual(['flaky'])
    expect(flaky?.tests[0]?.results.map((r) => [r.status, r.retry])).toEqual([
      ['failed', 0],
      ['passed', 1],
    ])
    expect(steady?.tests.map((t) => t.status)).toEqual(['expected'])
    // What the merge gate joins to name the test: the run's root and the spec's file relative to it.
    expect(join(report.config.rootDir, flaky!.file)).toBe(
      join(REPO, 'tests/e2e/fixtures/flaky-report/flaky-once.pw.ts'),
    )
  }, 90_000)
})
