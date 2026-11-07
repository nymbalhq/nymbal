import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { tallyGolden, type GoldenReport, type GoldenResult } from './eval.js'

// AC-10: `tallyGolden` judges each question over several runs of the golden set by majority: a question is ok when it
// passed in more than half of the runs, a tie fails, and the tally's `passed` counts the ok questions.

const resultOf = (id: string, ok: boolean): GoldenResult => ({
  id,
  ask: `the ask of ${id}`,
  ok,
  reasons: ok ? [] : [`${id} went wrong`],
  calls: [],
  proposals: [],
  answer: '',
  trace: [],
})

/** One run's report, its results in the order given. */
const reportOf = (verdicts: ReadonlyArray<readonly [string, boolean]>): GoldenReport => {
  const results = verdicts.map(([id, ok]) => resultOf(id, ok))
  return { passed: results.filter((r) => r.ok).length, total: results.length, results, models: [] }
}

describe('AC-10: tallyGolden judges each question by majority over the runs', () => {
  it('AC-10: over 3 runs a question passed in 2 is ok and one passed in 1 is not; over 2 runs 1 of 2 is not ok (a tie fails); over 1 run the verdicts are the report’s', () => {
    const three = tallyGolden([
      reportOf([
        ['books-count', true],
        ['pending-orders', true],
        ['weather', true],
      ]),
      reportOf([
        ['books-count', true],
        ['pending-orders', false],
        ['weather', true],
      ]),
      reportOf([
        ['books-count', false],
        ['pending-orders', false],
        ['weather', true],
      ]),
    ])
    const two = tallyGolden([
      reportOf([
        ['books-count', true],
        ['weather', true],
      ]),
      reportOf([
        ['books-count', false],
        ['weather', true],
      ]),
    ])
    const single = reportOf([
      ['books-count', false],
      ['pending-orders', true],
      ['weather', true],
    ])
    const one = tallyGolden([single])

    expect(three).toEqual({
      runs: 3,
      passed: 2,
      total: 3,
      questions: [
        { id: 'books-count', passed: 2, ok: true },
        { id: 'pending-orders', passed: 1, ok: false },
        { id: 'weather', passed: 3, ok: true },
      ],
    })
    expect(two.questions).toEqual([
      { id: 'books-count', passed: 1, ok: false },
      { id: 'weather', passed: 2, ok: true },
    ])
    expect(two.passed).toBe(1)
    expect(one.questions.map((q) => [q.id, q.ok])).toEqual(single.results.map((r) => [r.id, r.ok]))
    expect(one.passed).toBe(single.passed)
    expect(one.total).toBe(single.total)
  })

  it('AC-10: property: for any runs of the same question ids, in any order within a run, each question’s passed is the runs it passed in, ok is passed * 2 > runs, the questions keep the first run’s order and passed counts the ok questions', () => {
    const runs = fc
      .uniqueArray(fc.stringMatching(/^[a-z][a-z-]{0,11}$/), { minLength: 1, maxLength: 25 })
      .chain((ids) =>
        fc
          .array(
            fc.tuple(
              fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }),
              fc.shuffledSubarray(ids, { minLength: ids.length, maxLength: ids.length }),
            ),
            { minLength: 1, maxLength: 7 },
          )
          .map((rows) => ({ ids, rows })),
      )

    fc.assert(
      fc.property(runs, ({ ids, rows }) => {
        const verdict = (run: number, id: string) => rows[run]![0][ids.indexOf(id)]!
        // The first run lists the ids in their own order; a later one in its shuffled order.
        const reports = rows.map(([, order], run) =>
          reportOf((run === 0 ? ids : order).map((id) => [id, verdict(run, id)] as const)),
        )

        const tally = tallyGolden(reports)

        expect(tally.runs).toBe(rows.length)
        expect(tally.total).toBe(ids.length)
        expect(tally.questions.map((q) => q.id)).toEqual(ids)
        for (const q of tally.questions) {
          const passedIn = rows.filter((_, run) => verdict(run, q.id)).length
          expect(q.passed, q.id).toBe(passedIn)
          expect(q.ok, q.id).toBe(q.passed * 2 > rows.length)
        }
        expect(tally.passed).toBe(tally.questions.filter((q) => q.ok).length)
      }),
    )
  })
})
