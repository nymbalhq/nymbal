// Reads: nothing
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type EntryHistory,
  nextStatus,
  type RunResult,
  SUSPEND_AFTER_MS,
} from '../../scripts/registry/status'

// An adapter's registry status is a function of the clock: red on the first failing night, suspended once its
// failing streak is 7 days old, cleared by one green night. A no-suite night ends a streak like a pass.

const DAY = 24 * 3600 * 1000
const T0 = Date.parse('2026-01-05T03:00:00.000Z')

const PASS: RunResult = { kind: 'pass', passed: 30 }
const FAIL: RunResult = {
  kind: 'fail',
  line: 'not certified @acme/nymbal-search (search): 2 of 30 cases failed',
}
const NO_SUITE: RunResult = {
  kind: 'no-suite',
  line: "no contract suite for kind 'ai' in @nymbalhq/contract-tests",
}

/** Folds the runs, each at T0 plus its offset, through nextStatus; every state along the way. */
function fold(runs: Array<[offsetMs: number, result: RunResult]>): EntryHistory[] {
  const states: EntryHistory[] = []
  let prev: EntryHistory | undefined
  for (const [offset, result] of runs) {
    prev = nextStatus(prev, result, new Date(T0 + offset))
    states.push(prev)
  }
  return states
}

/** What the clock rule says the state after the last of `runs` is, from the runs alone. */
function oracle(runs: Array<{ at: number; result: RunResult }>): {
  status: EntryHistory['status']
  failingSince: string | null
  lastRun: string
} {
  const last = runs[runs.length - 1]!
  const lastRun = new Date(last.at).toISOString()
  if (last.result.kind === 'pass') return { status: 'passing', failingSince: null, lastRun }
  if (last.result.kind === 'no-suite') return { status: 'no-suite', failingSince: null, lastRun }
  let start = runs.length - 1
  while (start > 0 && runs[start - 1]!.result.kind === 'fail') start -= 1
  const since = runs[start]!.at
  return {
    status: last.at - since >= SUSPEND_AFTER_MS ? 'suspended' : 'failing',
    failingSince: new Date(since).toISOString(),
    lastRun,
  }
}

const result = fc.constantFrom<RunResult>(PASS, FAIL, NO_SUITE)
// Nightly gaps, missed nights, and gaps that land a streak exactly on or 1 ms short of the 7-day boundary.
const gap = fc.oneof(
  fc.integer({ min: 1, max: 3 * DAY }),
  fc.constantFrom(DAY, 2 * DAY, 7 * DAY, 7 * DAY - 1, 1),
)

describe('AC-1: status is a function of time, not of run count', () => {
  it('AC-1: after every run of any time-ordered sequence, status, failingSince and lastRun follow the clock rule', () => {
    expect(SUSPEND_AFTER_MS).toBe(7 * DAY)
    fc.assert(
      fc.property(fc.array(fc.tuple(gap, result), { minLength: 1, maxLength: 40 }), (steps) => {
        let at = T0
        const runs = steps.map(([g, r]) => ({ at: (at += g), result: r }))
        const states = fold(runs.map(({ at: t, result: r }) => [t - T0, r]))
        states.forEach((state, i) => {
          const want = oracle(runs.slice(0, i + 1))
          expect({
            status: state.status,
            failingSince: state.failingSince,
            lastRun: state.lastRun,
          }).toEqual(want)
          // A failure or no-suite night keeps its one line; a pass's line is the runner's to word.
          const r = runs[i]!.result
          expect(state.line).toBe(r.kind === 'pass' ? state.line : r.line)
        })
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: a streak is suspended exactly 7 days after its first failure, and 1 ms less is still failing', () => {
    const [, atBoundary] = fold([
      [0, FAIL],
      [SUSPEND_AFTER_MS, FAIL],
    ])
    const [, justShort] = fold([
      [0, FAIL],
      [SUSPEND_AFTER_MS - 1, FAIL],
    ])

    expect(atBoundary!.status).toBe('suspended')
    expect(justShort!.status).toBe('failing')
    expect(atBoundary!.failingSince).toBe(new Date(T0).toISOString())
    expect(justShort!.failingSince).toBe(atBoundary!.failingSince)
  })

  it('AC-1: seven failed nights in six days stay failing, and two failures ten days apart suspend', () => {
    const nightly = fold(
      Array.from({ length: 7 }, (_, d) => [d * DAY, FAIL] as [number, RunResult]),
    )
    const sparse = fold([
      [0, FAIL],
      [10 * DAY, FAIL],
    ])

    expect(nightly.map((s) => s.status)).toEqual(Array(7).fill('failing'))
    expect(new Set(nightly.map((s) => s.failingSince)).size).toBe(1)
    expect(sparse[1]!.status).toBe('suspended')
  })

  it('AC-1: a pass after suspended gives passing and clears failingSince, so the next single failure starts a new streak', () => {
    const states = fold([
      [0, FAIL],
      [8 * DAY, FAIL],
      [9 * DAY, PASS],
      [10 * DAY, FAIL],
    ])

    expect(states.map((s) => s.status)).toEqual(['failing', 'suspended', 'passing', 'failing'])
    expect(states[2]!.failingSince).toBeNull()
    expect(states[3]!.failingSince).toBe(states[3]!.lastRun)
  })

  it('AC-1: a no-suite run ends a failing streak, and no-suite nights never suspend', () => {
    const broken = fold([
      [0, FAIL],
      [5 * DAY, NO_SUITE],
      [8 * DAY, FAIL],
    ])
    const noSuite = fold(
      Array.from({ length: 12 }, (_, d) => [d * DAY, NO_SUITE] as [number, RunResult]),
    )

    expect(broken.map((s) => s.status)).toEqual(['failing', 'no-suite', 'failing'])
    expect(broken[2]!.failingSince).toBe(broken[2]!.lastRun)
    expect(noSuite.map((s) => s.status)).toEqual(Array(12).fill('no-suite'))
    expect(noSuite.every((s) => s.failingSince === null)).toBe(true)
  })
})
