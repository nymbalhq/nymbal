// Reads: nothing
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { lastRunRecord, type Step, type StepStatus } from '../../scripts/gate'

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
