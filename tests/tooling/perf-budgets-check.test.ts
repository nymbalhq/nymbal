// Reads: nothing
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { checkBudgets } from '../../scripts/perf-budgets-check'

// AC-1: the budget checker. A page passes iff every metric is at or under its budget (a NaN, which is what a page
// that failed to load measures as, is not); a budgeted page with no result fails as "not measured"; a measured page
// with no budget fails as "no budget"; and the failures name exactly the (page, metric) pairs that failed.

const METRICS = ['lcpMs', 'cls', 'tbtMs', 'scriptBytes'] as const
type Metric = (typeof METRICS)[number]
type Metrics = Record<Metric, number>

interface PageResult {
  template: string
  page: string
  url: string
  measured: Metrics
}

/** perf-budgets.json: template → page → the budget for each metric. */
type Budgets = Record<string, Record<string, Metrics>>

/** What checkBudgets returns per page: `failures` names each failing metric, or 'not measured', or 'no budget'. */
interface Verdict {
  template: string
  page: string
  ok: boolean
  failures: string[]
}

interface PageCase {
  template: string
  page: string
  budgeted: boolean
  budget: Metrics
  measured?: Metrics | undefined
}

const TEMPLATES = ['astro', 'nextjs'] as const
const PAGES = ['home', 'listing', 'product', 'cart', 'checkout'] as const

const key = (template: string, page: string): string => `${template} / ${page}`

const budgetArb: fc.Arbitrary<Metrics> = fc.record({
  lcpMs: fc.integer({ min: 0, max: 5000 }),
  cls: fc.integer({ min: 0, max: 500 }).map((n) => n / 1000),
  tbtMs: fc.integer({ min: 0, max: 1000 }),
  scriptBytes: fc.integer({ min: 0, max: 500_000 }),
})

/** A measured value relative to its budget: equal (passes), under, over, or NaN (a page that never loaded). */
const relative = (budget: number): fc.Arbitrary<number> =>
  fc.oneof(
    fc.constant(budget),
    fc.double({ min: 0, max: 1, noNaN: true }).map((f) => budget * f),
    fc.double({ min: 1e-6, max: 1000, noNaN: true }).map((d) => budget + d),
    fc.constant(Number.NaN),
  )

const measuredArb = (budget: Metrics): fc.Arbitrary<Metrics> =>
  fc.record({
    lcpMs: relative(budget.lcpMs),
    cls: relative(budget.cls),
    tbtMs: relative(budget.tbtMs),
    scriptBytes: relative(budget.scriptBytes),
  })

/**
 * Pages that are budgeted, pages that are measured (their union is every page of the case), each measured page's
 * values drawn around its budget when it has one, and around a random one when it has none.
 */
const caseArb = fc
  .uniqueArray(
    fc.record({
      template: fc.constantFrom(...TEMPLATES),
      page: fc.constantFrom(...PAGES),
      budgeted: fc.boolean(),
      measured: fc.boolean(),
    }),
    { minLength: 1, maxLength: 10, selector: (p) => key(p.template, p.page) },
  )
  .chain((pages) =>
    fc.tuple(
      ...pages.map((p) =>
        budgetArb.chain((budget) =>
          measuredArb(budget).map((measured) => ({
            ...p,
            budgeted: p.budgeted || !p.measured,
            budget,
            measured: p.measured ? measured : undefined,
          })),
        ),
      ),
    ),
  )

function inputsOf(pages: PageCase[]): {
  results: PageResult[]
  budgets: Budgets
} {
  const results: PageResult[] = []
  const budgets: Budgets = {}
  for (const p of pages) {
    if (p.budgeted) (budgets[p.template] ??= {})[p.page] = p.budget
    if (p.measured !== undefined) {
      results.push({ template: p.template, page: p.page, url: `/${p.page}`, measured: p.measured })
    }
  }
  return { results, budgets }
}

/** What the checker must say for one page: the reasons it fails, empty when it passes. */
function expectedFailures(p: PageCase): string[] {
  if (p.measured === undefined) return ['not measured']
  if (!p.budgeted) return ['no budget']
  const measured = p.measured
  // `!(a <= b)` and not `a > b`: NaN fails.
  return METRICS.filter((m) => !(measured[m] <= p.budget[m]))
}

describe('AC-1: checkBudgets', () => {
  it('AC-1: a page passes iff every metric is at or under budget; unmeasured and unbudgeted pages fail; exactly the failing (page, metric) pairs are named', () => {
    fc.assert(
      fc.property(caseArb, (pages) => {
        const { results, budgets } = inputsOf(pages)
        const verdicts: Verdict[] = checkBudgets(results, budgets)

        // One verdict per page that is budgeted or measured, and no other.
        const seen = verdicts.map((v) => key(v.template, v.page)).sort()
        expect(seen).toEqual(pages.map((p) => key(p.template, p.page)).sort())

        for (const p of pages) {
          const verdict = verdicts.find((v) => v.template === p.template && v.page === p.page)!
          const expected = expectedFailures(p)
          expect([...verdict.failures].sort()).toEqual([...expected].sort())
          expect(verdict.ok).toBe(expected.length === 0)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: a regression on one metric of one page fails that pair alone, and the same page at its budget passes', () => {
    fc.assert(
      fc.property(
        budgetArb,
        fc.constantFrom(...METRICS),
        fc.integer({ min: 1, max: 10_000 }),
        (budget, metric, over) => {
          const budgets: Budgets = { astro: { home: budget } }
          const atBudget: Verdict[] = checkBudgets(
            [{ template: 'astro', page: 'home', url: '/', measured: { ...budget } }],
            budgets,
          )
          const regressed: Verdict[] = checkBudgets(
            [
              {
                template: 'astro',
                page: 'home',
                url: '/',
                measured: { ...budget, [metric]: budget[metric] + over / 1000 },
              },
            ],
            budgets,
          )
          expect(atBudget.map((v) => v.ok)).toEqual([true])
          expect(regressed.map((v) => [v.ok, v.failures])).toEqual([[false, [metric]]])
        },
      ),
    )
  })
})
