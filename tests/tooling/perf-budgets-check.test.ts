// Reads: tests/perf/fixtures/**
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { checkBudgets, SCRIPT_REFERENCES, summarize } from '../../scripts/perf-budgets-check'

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

// summarize: what a page's runs come to before checkBudgets judges them. Lighthouse's LCP for one build lands in a fast
// or a slow mode some 400 ms apart, in a share of runs that changes from one CI run to the next; LCP is read at the
// lower quartile of the runs (of seven, the second fastest; under five measured runs, the median), so the slow share
// does not decide the verdict, while a regression that moves both modes still fails. Every other metric stays at its
// median.

const BUDGET: Metrics = { lcpMs: 2500, cls: 0.1, tbtMs: 200, scriptBytes: 200_000 }
const UNDER = { cls: 0.05, tbtMs: 50, scriptBytes: 100_000 }

const lcpRuns = (lcps: readonly number[]): Metrics[] => lcps.map((lcpMs) => ({ ...UNDER, lcpMs }))

const failuresOf = (samples: readonly Metrics[]): string[] =>
  checkBudgets(
    [{ template: 'nextjs', page: 'checkout', url: '/checkout', measured: summarize(samples) }],
    { nextjs: { checkout: BUDGET } },
  )[0]!.failures

/** Seven runs in any order: `fast` of them at `f`, the rest at `f + gap`. */
const bimodalArb = fc
  .record({
    f: fc.integer({ min: 500, max: 4000 }),
    gap: fc.integer({ min: 1, max: 1500 }),
    fast: fc.integer({ min: 0, max: 7 }),
  })
  .chain(({ f, gap, fast }) =>
    fc
      .shuffledSubarray(
        Array.from({ length: 7 }, (_, i) => (i < fast ? f : f + gap)),
        { minLength: 7, maxLength: 7 },
      )
      .map((lcps) => ({ f, slow: f + gap, fast, lcps })),
  )

const measuredLcps = fc.array(
  fc.oneof(
    { weight: 9, arbitrary: fc.integer({ min: 0, max: 10_000 }) },
    { weight: 1, arbitrary: fc.constant(Number.NaN) },
  ),
  { minLength: 1, maxLength: 9 },
)

describe('summarize: a page over its runs', () => {
  it('property: of seven runs, LCP is the fast mode when two or more runs reach it and the slow mode otherwise, so a budget between the modes passes on two fast runs and fails on one', () => {
    fc.assert(
      fc.property(bimodalArb, ({ f, slow, fast, lcps }) => {
        const expected = fast >= 2 ? f : slow
        expect(summarize(lcpRuns(lcps)).lcpMs).toBe(expected)
        // A budget at the fast mode, under the slow one.
        const failures = checkBudgets(
          [{ template: 'nextjs', page: 'cart', url: '/cart', measured: summarize(lcpRuns(lcps)) }],
          { nextjs: { cart: { ...BUDGET, lcpMs: f } } },
        )[0]!.failures
        expect(failures).toEqual(fast >= 2 ? [] : ['lcpMs'])
      }),
      { numRuns: 300 },
    )
  })

  it('property: a regression that adds Δ to every run adds Δ to LCP, so a page at its budget fails once every run is slower', () => {
    fc.assert(
      fc.property(
        measuredLcps.filter((l) => l.some((v) => !Number.isNaN(v))),
        fc.integer({ min: 1, max: 2000 }),
        (lcps, delta) => {
          const before = summarize(lcpRuns(lcps)).lcpMs
          const after = summarize(lcpRuns(lcps.map((v) => v + delta))).lcpMs
          expect(after).toBe(before + delta)
          const budgets = { astro: { home: { ...BUDGET, lcpMs: before } } }
          const verdict = (l: readonly number[]): string[] =>
            checkBudgets(
              [{ template: 'astro', page: 'home', url: '/', measured: summarize(lcpRuns(l)) }],
              budgets,
            )[0]!.failures
          expect(verdict(lcps)).toEqual([])
          expect(verdict(lcps.map((v) => v + delta))).toEqual(['lcpMs'])
        },
      ),
      { numRuns: 300 },
    )
  })

  it('one stray fast run does not hide a regression: six of seven runs over budget fail LCP however fast the seventh', () => {
    const slow = [2700, 2650, 2690, 2660, 2710, 2680]
    expect(failuresOf(lcpRuns([...slow, 1500]))).toEqual(['lcpMs'])
    // Two fast runs are the fast mode: the same page passes.
    expect(failuresOf(lcpRuns([...slow.slice(1), 2100, 2110]))).toEqual([])
  })

  it('under five measured runs LCP is the median, so one fast run of three does not pass a page whose others are over budget', () => {
    expect(summarize(lcpRuns([2720, 2690, 2110])).lcpMs).toBe(2690)
    expect(failuresOf(lcpRuns([2720, 2690, 2110]))).toEqual(['lcpMs'])
    // Seven runs of which four failed leave three measured: the median of those three, not the fastest.
    const nan = Number.NaN
    expect(summarize(lcpRuns([nan, 2720, nan, 2690, nan, 2110, nan])).lcpMs).toBe(2690)
    expect(failuresOf(lcpRuns([nan, 2720, nan, 2690, nan, 2110, nan]))).toEqual(['lcpMs'])
    // Five measured runs read the lower quartile again: the second fastest.
    expect(summarize(lcpRuns([2720, 2690, 2700, 2110, 2120])).lcpMs).toBe(2120)
  })

  it('property: CLS, TBT and script bytes stay at the median, so most runs over the TBT budget fail it whatever LCP does', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            lcpMs: fc.integer({ min: 0, max: 5000 }),
            cls: fc.integer({ min: 0, max: 500 }).map((n) => n / 1000),
            tbtMs: fc.integer({ min: 0, max: 1000 }),
            scriptBytes: fc.integer({ min: 0, max: 500_000 }),
          }),
          { minLength: 1, maxLength: 9 },
        ),
        (samples) => {
          const summary = summarize(samples)
          for (const metric of ['cls', 'tbtMs', 'scriptBytes'] as const) {
            const values = samples.map((s) => s[metric])
            const atOrUnder = values.filter((v) => v <= summary[metric]).length
            const atOrOver = values.filter((v) => v >= summary[metric]).length
            expect(atOrUnder * 2, metric).toBeGreaterThanOrEqual(values.length)
            expect(atOrOver * 2, metric).toBeGreaterThanOrEqual(values.length)
          }
        },
      ),
      { numRuns: 300 },
    )
    const runs = lcpRuns([2100, 2100, 2100, 2100, 2100, 2100, 2100]).map((s, i) => ({
      ...s,
      tbtMs: i < 4 ? 300 : 100,
    }))
    expect(failuresOf(runs)).toEqual(['tbtMs'])
  })

  it('property: a run that failed (NaN) is left out, and a page where every run failed fails every metric', () => {
    fc.assert(
      fc.property(
        measuredLcps.filter((l) => l.some((v) => !Number.isNaN(v))),
        fc.integer({ min: 1, max: 4 }),
        (lcps, failed) => {
          const measured = lcpRuns(lcps.filter((v) => !Number.isNaN(v)))
          const nan: Metrics = {
            lcpMs: Number.NaN,
            cls: Number.NaN,
            tbtMs: Number.NaN,
            scriptBytes: Number.NaN,
          }
          const withFailed = [...lcpRuns(lcps), ...Array.from({ length: failed }, () => nan)]
          expect(summarize(withFailed)).toEqual(summarize(measured))
          expect(failuresOf(Array.from({ length: failed }, () => nan)).sort()).toEqual(
            ['cls', 'lcpMs', 'scriptBytes', 'tbtMs'].sort(),
          )
        },
      ),
      { numRuns: 200 },
    )
  })
})

// AC-7: the options a bytes-only run judges with. `metrics` limits the judged metrics, so the NaN that a run without
// Lighthouse leaves in LCP, CLS and TBT fails nothing; a reference fails a matching page above its bytes, under budget
// or not, as `scriptBytes (reference <commit>)`.

const REPO = fileURLToPath(new URL('../../', import.meta.url))

interface Reference {
  commit: string
  template: string
  page: string
  scriptBytes: number
}

const NAN_TIMINGS = { lcpMs: Number.NaN, cls: Number.NaN, tbtMs: Number.NaN }

describe('AC-7: checkBudgets options', () => {
  it('AC-7: property: with metrics [scriptBytes], a page passes iff its scriptBytes is at or under budget, whatever NaN LCP, CLS and TBT it has', () => {
    fc.assert(
      fc.property(
        budgetArb.chain((budget) =>
          relative(budget.scriptBytes).map((scriptBytes) => ({ budget, scriptBytes })),
        ),
        ({ budget, scriptBytes }) => {
          const verdicts: Verdict[] = checkBudgets(
            [
              {
                template: 'astro',
                page: 'home',
                url: '/',
                measured: { ...NAN_TIMINGS, scriptBytes },
              },
            ],
            { astro: { home: budget } },
            { metrics: ['scriptBytes'] },
          )
          const over = !(scriptBytes <= budget.scriptBytes)
          expect(verdicts.map((v) => [v.ok, v.failures])).toEqual([
            [!over, over ? ['scriptBytes'] : []],
          ])
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-7: property: a page above its reference fails "scriptBytes (reference <commit>)" under budget, one at or under it passes, and another page is not held to it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 200_000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: -2000, max: 5000 }),
        fc.stringMatching(/^[0-9a-f]{7}$/),
        (referenceBytes, headroom, delta, commit) => {
          const budgetBytes = referenceBytes + headroom
          const scriptBytes = Math.min(referenceBytes + delta, budgetBytes)
          const budget = { lcpMs: 2500, cls: 0.1, tbtMs: 200, scriptBytes: budgetBytes }
          const timings = { lcpMs: 1000, cls: 0, tbtMs: 0 }
          const reference: Reference = {
            commit,
            template: 'astro',
            page: 'home',
            scriptBytes: referenceBytes,
          }
          const verdicts: Verdict[] = checkBudgets(
            [
              { template: 'astro', page: 'home', url: '/', measured: { ...timings, scriptBytes } },
              {
                template: 'astro',
                page: 'cart',
                url: '/cart',
                measured: { ...timings, scriptBytes },
              },
            ],
            { astro: { home: budget, cart: budget } },
            { references: [reference] },
          )
          const above = scriptBytes > referenceBytes
          const of = (page: string): Verdict | undefined => verdicts.find((v) => v.page === page)
          expect(of('home')?.failures).toEqual(above ? [`scriptBytes (reference ${commit})`] : [])
          expect(of('home')?.ok).toBe(!above)
          expect(of('cart')?.failures).toEqual([])
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-7: every SCRIPT_REFERENCES file parses to { commit, template, page, scriptBytes } and holds its page to those bytes', () => {
    expect(SCRIPT_REFERENCES).toContain('tests/perf/fixtures/astro-home-64db4b0.json')
    for (const path of SCRIPT_REFERENCES) {
      const parsed = JSON.parse(readFileSync(join(REPO, path), 'utf8')) as Reference
      const reference: Reference = {
        commit: parsed.commit,
        template: parsed.template,
        page: parsed.page,
        scriptBytes: parsed.scriptBytes,
      }
      expect(reference.commit, path).toMatch(/^[0-9a-f]{7,40}$/)
      expect(Number.isInteger(reference.scriptBytes) && reference.scriptBytes > 0, path).toBe(true)
      const budgets: Budgets = {
        [reference.template]: {
          [reference.page]: {
            lcpMs: 2500,
            cls: 0.1,
            tbtMs: 200,
            scriptBytes: reference.scriptBytes * 2,
          },
        },
      }
      const judge = (scriptBytes: number): Verdict[] =>
        checkBudgets(
          [
            {
              template: reference.template,
              page: reference.page,
              url: '/',
              measured: { ...NAN_TIMINGS, scriptBytes },
            },
          ],
          budgets,
          { metrics: ['scriptBytes'], references: [reference] },
        )
      expect(
        judge(reference.scriptBytes).map((v) => v.failures),
        path,
      ).toEqual([[]])
      expect(
        judge(reference.scriptBytes + 1).map((v) => v.failures),
        path,
      ).toEqual([[`scriptBytes (reference ${reference.commit})`]])
    }
  })
})
