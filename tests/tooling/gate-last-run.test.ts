// Reads: nothing
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { lastRunRecord, run, type Step, type StepStatus } from '../../scripts/gate'
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
