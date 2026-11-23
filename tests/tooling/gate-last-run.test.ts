// Reads: nothing
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  failedTests,
  lastRunRecord,
  run,
  type RunRecord,
  type Step,
  type StepStatus,
  type VitestReport,
  writeLastRun,
} from '../../scripts/gate'
import { CAP_VARS, LOCAL_DEFAULTS, MACHINE_ENV_FILE_VAR } from '../../scripts/machine-budget'
import type { Hold } from '../../scripts/stack'

// The Stop hook reads reports/last-run.json's `stepsMs` (a name=ms pair per step) and `redStep` (the step to name in
// its message) to judge a gate run, so the record carries a time for every step and names the first red one.

const STATUSES: StepStatus[] = ['ok', 'red', 'skipped']

const stepsArb = fc
  .uniqueArray(fc.stringMatching(/^[a-z][a-z-]{0,11}$/), { minLength: 1, maxLength: 8 })
  .chain((names) =>
    fc.tuple(
      ...names.map((name) =>
        fc.record({
          name: fc.constant(name),
          status: fc.constantFrom(...STATUSES),
          ms: fc.nat({ max: 600_000 }),
        }),
      ),
    ),
  )

describe('the last-run record', () => {
  it('for any steps, stepsMs keys are the steps keys in order, each the step’s ms, and redStep is the first red step or null', () => {
    fc.assert(
      fc.property(stepsArb, (steps: Step[]) => {
        const last = lastRunRecord('abc', steps)
        expect(Object.keys(last.stepsMs)).toEqual(Object.keys(last.steps))
        expect(Object.keys(last.steps)).toEqual(steps.map((s) => s.name))
        expect(Object.values(last.stepsMs)).toEqual(steps.map((s) => s.ms))
        const reds = steps.filter((s) => s.status === 'red')
        expect(last.redStep).toBe(reds.length === 0 ? null : reds[0]!.name)
      }),
      { numRuns: 200 },
    )
  })

  it('names the first of two red steps, not the last', () => {
    const steps: Step[] = [
      { name: 'lint', status: 'ok', ms: 900 },
      { name: 'typecheck', status: 'red', ms: 4200 },
      { name: 'tests', status: 'red', ms: 18_000 },
    ]
    const last = lastRunRecord('abc', steps)
    expect(last.redStep).toBe('typecheck')
    expect(last.stepsMs).toEqual({ lint: 900, typecheck: 4200, tests: 18_000 })
  })
})

// Why a step was slow: how long it waited for its hold, the one-minute load when it started and the caps it ran under,
// per step, beside the keys the readers above take.
describe('the last-run record says what each step waited for and ran under', () => {
  const created: string[] = []
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('a held Vitest step records its wait, its load and its cap; an unheld step its load only; a skipped step nothing', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-last-run-')))
    created.push(cwd)
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of [...Object.values(CAP_VARS), 'CI', 'GITHUB_ACTIONS']) delete env[name]
    env[MACHINE_ENV_FILE_VAR] = join(tmpdir(), 'nymbal-no-machine-file.env')
    const loads = [6.25, 13.5]
    let log = ''
    const result = await run(
      [
        { name: 'lint', command: 'true' },
        { name: 'tests', command: 'true', hold: 'shared' },
        { name: 'perf', command: 'true', skip: 'left to gate:full and dev CI' },
      ],
      {
        cwd,
        budgetMs: 60_000,
        env,
        acquire: async (): Promise<Hold> =>
          Object.assign(async () => {}, { waitedMs: 4_321, quiet: true }),
        loadAverage: () => loads.shift() ?? 0,
        cpus: 12,
        platform: 'linux',
        log: (text) => {
          log += text
        },
      },
    )
    const last = lastRunRecord('abc', result.steps)
    expect(last.waitsMs).toEqual({ tests: 4_321 })
    expect(last.loads).toEqual({ lint: 6.25, tests: 13.5 })
    // Loaded past the 12 cores: the cap halved.
    expect(last.caps).toEqual({ tests: { vitest: Math.max(1, Math.floor(LOCAL_DEFAULTS.vitest / 2)) } })
    expect(Object.keys(last.steps)).toEqual(['lint', 'tests', 'perf'])
    expect(log).toContain("tests: started after a 4.3 s wait for other worktrees' heavy steps")
  })
})

// A run often ends while nobody is reading (a backgrounded call), and the next run overwrites last-run.json; the run
// log keeps every run's record, with its time and the tests it saw fail, for whoever reads them later.
describe('every run leaves its record in the run log', () => {
  const created: string[] = []
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('two runs leave two lines in run order, and last-run.json holds the second', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-run-log-')))
    created.push(root)
    const record = (sha: string, startedMs: number, status: StepStatus): RunRecord => ({
      ...lastRunRecord(sha, [{ name: 'tests', status, ms: 1_000 }]),
      startedMs,
      endedMs: startedMs + 1_000,
      full: false,
      failed: status === 'red' ? ['src/a.test.ts::a holds'] : [],
    })
    const first = record('aaa', 1_000_000, 'red')
    const second = record('bbb', 2_000_000, 'ok')
    writeLastRun(root, first)
    writeLastRun(root, second)
    const lines = readFileSync(join(root, 'reports/gate-runs.jsonl'), 'utf8').trim().split('\n')
    expect(lines.map((line) => JSON.parse(line) as RunRecord)).toEqual([first, second])
    expect(JSON.parse(readFileSync(join(root, 'reports/last-run.json'), 'utf8'))).toEqual(second)
  })

  it('for any Vitest report, the failed tests are its failed assertions, in order, each under its file relative to the checkout', () => {
    const root = '/repo'
    const reportArb = fc.array(
      fc.record({
        file: fc.stringMatching(/^[a-z]{1,8}\.test\.ts$/),
        tests: fc.array(
          fc.record({
            fullName: fc.stringMatching(/^[a-z ]{1,12}$/),
            status: fc.constantFrom('passed', 'failed', 'skipped'),
          }),
          { maxLength: 5 },
        ),
      }),
      { maxLength: 4 },
    )
    fc.assert(
      fc.property(reportArb, (files) => {
        const report: VitestReport = {
          testResults: files.map((f) => ({
            name: `${root}/src/${f.file}`,
            assertionResults: f.tests,
          })),
        }
        const expected = files.flatMap((f) =>
          f.tests.filter((t) => t.status === 'failed').map((t) => `src/${f.file}::${t.fullName}`),
        )
        expect(failedTests(root, report)).toEqual(expected)
      }),
      { numRuns: 200 },
    )
    expect(failedTests(root, undefined)).toEqual([])
  })
})
