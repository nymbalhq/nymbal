import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ReportSummary } from '@nymbalhq/types'
import { readReport } from '../../src/reports/report.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import {
  DATA_DAY,
  DAY_MS,
  NOW,
  ZONE,
  applyFigures,
  daysBack,
  daysRange,
  draftsOf,
  funnelOn,
  insightEvents,
  insightRows,
  numbersNotInFacts,
  paidOn,
  resetNight,
  runRows,
  runTwice,
  searchedOn,
  seedRefund,
  shippedJob,
  soldOn,
  spreadSold,
  type SoldVariant,
} from '../support/night-shift.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { clearReports, noonOf, seedOrder } from '../support/report-rollups.js'

// The five jobs on seeded figures: each fixture seeds one fault beside subjects that must not fire, runs the night
// twice for the same `now`, and reads back the insights and their events. Figures go in as the report handler writes
// them; the jobs are the shipped ones, run alone through `deps.jobs`.

let k: Kernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await k?.close()
})

beforeEach(async () => {
  await resetNight(k)
})

const NEXT_NIGHT = new Date(NOW.getTime() + DAY_MS)

async function variantWith(
  stock: number,
  name = 'Merino crew sock',
  sku?: string,
): Promise<SoldVariant> {
  const seeded = await seedVariant(k, stock)
  return {
    variantId: seeded.variantId,
    productId: seeded.productId,
    productName: name,
    sku: sku ?? `SKU-${seeded.variantId.slice(0, 6)}`,
  }
}

/** `perDay` units of `v` sold on each of `days`. */
const sold = (v: SoldVariant, days: string[], perDay = 1) =>
  days.map((day) => soldOn(day, v, perDay))

async function night(job: Parameters<typeof shippedJob>[0], now = NOW) {
  const runs = await runTwice(k, now, [shippedJob(job)])
  return { runs, rows: await insightRows(raw, job), events: await insightEvents(raw, job) }
}

describe('AC-3: stock runway fixture', () => {
  it('AC-3: of a variant 5 days from running out, one 100 days out, one with a single unit sold and one out of stock, only the first gets an insight, once, carrying the report’s runway figures', async () => {
    const a = await variantWith(5, 'Merino crew sock', 'MCS-42')
    const b = await variantWith(100)
    const c = await variantWith(2)
    const d = await variantWith(0)
    const window = daysRange(27, 0)
    await applyFigures(k, [
      ...sold(a, window),
      ...sold(b, window),
      ...sold(d, window),
      soldOn(DATA_DAY, c, 1),
    ])

    const { rows, events } = await night('stock-runway')

    expect(rows.map((r) => r.subject)).toEqual([`variant:${a.variantId}`])
    expect(events.map((e) => e.insightId)).toEqual(rows.map((r) => r.id))
    const report = (await readReport(
      { store: k.store, repo: k.repos.reportRollup, timeZone: ZONE, now: () => NOW },
      { limit: 50 },
    )) as ReportSummary
    const item = report.stockRunway.items.find((i) => i.variantId === a.variantId)!
    expect(rows[0]!.facts).toEqual({
      productName: item.productName,
      sku: item.sku,
      stock: item.stock,
      unitsSold: item.unitsSold,
      windowDays: item.windowDays,
      daysLeft: Math.floor(item.daysLeft),
    })
    expect(rows[0]!.severity).toBe('warning')
  })

  it('AC-3: on a store with a 7-day window, a variant with 2 units sold and 1 in stock gets none while one with 3 sold and 5 in stock does', async () => {
    const few = await variantWith(1)
    const enough = await variantWith(5)
    const week = daysRange(6, 0)
    await applyFigures(k, [
      soldOn(week[0]!, few, 1),
      soldOn(week[6]!, few, 1),
      ...sold(enough, week.slice(0, 3)),
    ])

    const { rows } = await night('stock-runway')

    expect(rows.map((r) => r.subject)).toEqual([`variant:${enough.variantId}`])
    expect(rows[0]!.facts['unitsSold']).toBe(3)
  })
})

describe('AC-4: stock runway is capped, soonest out first, and the rest surface the next night', () => {
  it('AC-4: of 12 variants under the runway the first night writes the 10 soonest out, in that order, and the next night the other 2', async () => {
    const variants: SoldVariant[] = []
    for (let stock = 1; stock <= 12; stock += 1) variants.push(await variantWith(stock))
    // Seeded in reverse, so an order taken from the seed would be backwards.
    await applyFigures(
      k,
      [...variants].reverse().flatMap((v) => sold(v, daysRange(27, 0))),
    )

    const first = await night('stock-runway')

    const subjects = variants.map((v) => `variant:${v.variantId}`)
    expect(first.rows.map((r) => r.subject).sort()).toEqual(subjects.slice(0, 10).sort())
    expect(first.events.map((e) => e.subject)).toEqual(subjects.slice(0, 10))

    const second = await night('stock-runway', NEXT_NIGHT)
    const secondNight = second.rows.filter((r) => r.runDay !== first.rows[0]!.runDay)
    expect(secondNight.map((r) => r.subject).sort()).toEqual(subjects.slice(10).sort())
    expect(second.rows).toHaveLength(12)
  })

  it('AC-4: a store with 6 days of figures writes no runway insight, and one with 7 days writes it', async () => {
    const v = await variantWith(5)
    await applyFigures(k, sold(v, daysRange(5, 0), 3))
    const short = await night('stock-runway')
    const [shortRun] = await runRows(raw)

    await resetNight(k)
    const w = await variantWith(5)
    await applyFigures(k, sold(w, daysRange(6, 0), 3))
    const week = await night('stock-runway')

    expect(shortRun).toMatchObject({ job: 'stock-runway', status: 'done', insights: 0 })
    expect(short.rows.length + short.events.length).toBe(0)
    expect(week.rows.map((r) => r.subject)).toEqual([`variant:${w.variantId}`])
    expect(week.rows[0]!.facts['windowDays']).toBe(7)
  })
})

describe('AC-5: zero-result term fixture', () => {
  it('AC-5: of the data day’s terms only "wool socks" fires: a term under 3 searches, one also searched 10 days earlier, an email and a phone number, spaced or bare, do not, and none of them reaches a subject or a fact', async () => {
    await applyFigures(k, [
      searchedOn(DATA_DAY, 'wool socks', 3),
      searchedOn(DATA_DAY, 'wol socs', 1),
      searchedOn(DATA_DAY, 'old term', 4),
      searchedOn(daysBack(10), 'old term', 1),
      searchedOn(DATA_DAY, 'jo@example.com', 3),
      searchedOn(DATA_DAY, 'call 07700 900123', 3),
      searchedOn(DATA_DAY, '07700900123', 3),
      searchedOn(DATA_DAY, '+447700900123', 3),
      searchedOn(DATA_DAY, '07700-900-123', 3),
    ])

    const { rows, events } = await night('zero-result-term')

    expect(rows.map((r) => r.subject)).toEqual(['term:wool socks'])
    expect(rows[0]!.facts).toEqual({ term: 'wool socks', searches: 3, quietDays: 30 })
    expect(events.map((e) => e.insightId)).toEqual(rows.map((r) => r.id))
    expect(JSON.stringify([rows, events])).not.toMatch(/example\.com|07700|7700900123/)
  })
})

describe('AC-6: zero-result terms are capped at 5, most searched first', () => {
  it('AC-6: of 7 new terms the night writes 5, by searches then term', async () => {
    const counts: Array<[string, number]> = [
      ['golf', 3],
      ['foxtrot', 5],
      ['echo', 5],
      ['delta', 5],
      ['charlie', 7],
      ['bravo', 8],
      ['alpha', 9],
    ]
    await applyFigures(
      k,
      counts.map(([term, n]) => searchedOn(DATA_DAY, term, n)),
    )

    const { events } = await night('zero-result-term')
    const firstNight = await insightRows(raw, 'zero-result-term')

    const expected = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((t) => `term:${t}`)
    expect(events.map((e) => e.subject)).toEqual(expected)
    expect(firstNight.map((r) => r.subject).sort()).toEqual([...expected].sort())
  })
})

/** Storefront paid orders on the 7 days before the data day, then on the data day. */
async function demandFigures(trailing: number[], onDataDay: number, source = 'storefront') {
  const days = daysRange(7, 1)
  await applyFigures(k, [
    ...days.map((day, i) => paidOn(day, trailing[i]!, source)).filter((_, i) => trailing[i]! > 0),
    ...(onDataDay > 0 ? [paidOn(DATA_DAY, onDataDay, source)] : []),
  ])
}

describe('AC-7: demand / orders fixture', () => {
  it('AC-7: a store paid 10 a day that took 3 on the data day gets one orders insight with the mean and the share of it', async () => {
    const trailing = [10, 10, 10, 10, 10, 10, 11]
    await demandFigures(trailing, 3)

    const { rows, events } = await night('demand')

    expect(rows.map((r) => r.subject)).toEqual(['orders'])
    expect(events.map((e) => e.insightId)).toEqual(rows.map((r) => r.id))
    const mean = trailing.reduce((s, n) => s + n, 0) / trailing.length
    expect(rows[0]!.facts).toMatchObject({
      paidOrders: 3,
      trailingMean: Math.round(mean * 10) / 10,
      percentOfMean: Math.round((3 / mean) * 100),
    })
    expect(numbersNotInFacts(rows[0]!.summary, rows[0]!.facts)).toEqual([])
  })

  it('AC-7: 7 on the data day against 10 a day, a store of 2 a day with none, and 10 a day of agent or imported orders on top of 4 storefront ones, write nothing', async () => {
    const cases: Array<() => Promise<void>> = [
      () => demandFigures([10, 10, 10, 10, 10, 10, 10], 7),
      () => demandFigures([2, 2, 2, 2, 2, 2, 2], 0),
      async () => {
        await demandFigures([4, 4, 4, 4, 4, 4, 4], 1)
        await applyFigures(k, [
          ...daysRange(7, 1).map((day) => paidOn(day, 10, 'agent:scout')),
          ...daysRange(7, 1).map((day) => paidOn(day, 10, 'import')),
        ])
      },
    ]
    const written: number[] = []
    for (const seed of cases) {
      await resetNight(k)
      await seed()
      const { rows, events } = await night('demand')
      written.push(rows.length + events.length)
    }
    expect(written).toEqual(cases.map(() => 0))
  })
})

describe('AC-8: demand / checkout fixture', () => {
  async function checkoutFigures(trailing: [number, number], dataDay: [number, number]) {
    const days = daysRange(7, 1)
    await applyFigures(k, [
      ...days.flatMap((day) => [
        funnelOn(day, { checkoutsStarted: trailing[0] }),
        paidOn(day, trailing[1]),
      ]),
      funnelOn(DATA_DAY, { checkoutsStarted: dataDay[0] }),
      paidOn(DATA_DAY, dataDay[1]),
    ])
  }

  it('AC-8: 20 started / 16 paid a day, then 20 / 8, makes exactly one insight, checkout (8 orders is half the mean, not under it)', async () => {
    await checkoutFigures([20, 16], [20, 8])

    const { rows, events } = await night('demand')

    expect(rows.map((r) => r.subject)).toEqual(['checkout'])
    expect(rows[0]!.severity).toBe('critical')
    expect(rows[0]!.facts).toMatchObject({
      paidOrders: 8,
      checkoutsStarted: 20,
      successPercent: Math.round((8 / 20) * 100),
      trailingSuccessPercent: Math.round(((16 * 7) / (20 * 7)) * 100),
    })
    expect(numbersNotInFacts(rows[0]!.summary, rows[0]!.facts)).toEqual([])
    expect(events.map((e) => e.insightId)).toEqual(rows.map((r) => r.id))
  })

  it('AC-8: 20 / 13 on the data day, 9 started on the data day, and 49 started over the week write no checkout insight', async () => {
    const cases: Array<[[number, number], [number, number]]> = [
      [
        [20, 16],
        [20, 13],
      ],
      [
        [20, 16],
        [9, 4],
      ],
      [
        [7, 6],
        [20, 8],
      ],
    ]
    const subjects: string[][] = []
    const unbacked: string[][] = []
    for (const [trailing, dataDay] of cases) {
      await resetNight(k)
      await checkoutFigures(trailing, dataDay)
      const { rows } = await night('demand')
      subjects.push(rows.map((r) => r.subject))
      unbacked.push(rows.flatMap((r) => numbersNotInFacts(r.summary, r.facts)))
    }
    // 9 / 4 is also an orders fall (4 against 16 a day), which fires on its own subject.
    expect(subjects).toEqual([[], ['orders'], []])
    expect(unbacked).toEqual([[], [], []])
  })
})

describe('AC-9: viewers are a detail of demand, never its trigger', () => {
  it('AC-9: with 150 storefront viewers on the data day the orders insight carries viewers and paid per viewer; with 99 it carries neither', async () => {
    const factsWith = async (viewers: number) => {
      await resetNight(k)
      await demandFigures([10, 10, 10, 10, 10, 10, 10], 3)
      await applyFigures(k, [funnelOn(DATA_DAY, { viewers })])
      const { rows } = await night('demand')
      expect(rows.map((r) => r.subject)).toEqual(['orders'])
      return rows[0]!.facts
    }

    const many = await factsWith(150)
    const few = await factsWith(99)

    expect(many).toMatchObject({ viewers: 150, paidPerViewerPercent: Math.round((3 / 150) * 100) })
    expect(Object.keys(few)).not.toContain('viewers')
    expect(Object.keys(few)).not.toContain('paidPerViewerPercent')
    expect(
      Object.keys(many)
        .filter((key) => !(key in few))
        .sort(),
    ).toEqual(['paidPerViewerPercent', 'viewers'])
  })

  it('AC-9: viewers falling from 1,000 a day to 100 with orders and checkouts steady writes nothing', async () => {
    const days = daysRange(7, 1)
    await applyFigures(k, [
      ...days.flatMap((day) => [
        funnelOn(day, { viewers: 1_000, checkoutsStarted: 20 }),
        paidOn(day, 10),
      ]),
      funnelOn(DATA_DAY, { viewers: 100, checkoutsStarted: 20 }),
      paidOn(DATA_DAY, 10),
    ])

    const { rows, events } = await night('demand')

    expect(rows.length + events.length).toBe(0)
    const [run] = await runRows(raw)
    expect(run).toMatchObject({ job: 'demand', status: 'done', insights: 0 })
  })
})

describe('AC-13: jobs that compare with the past wait until the store has a past', () => {
  it('AC-13: with no figures at all, stock-runway, demand and refund-rate write nothing and their runs are done with 0', async () => {
    const order = await seedOrder(k, { source: 'storefront' })
    for (const back of [0, 1, 2, 3, 4, 5])
      await seedRefund(k, { orderId: order.id, at: noonOf(daysBack(back)) })
    const jobs = (['stock-runway', 'demand', 'refund-rate'] as const).map((id) => shippedJob(id))

    await runTwice(k, NOW, jobs)

    expect(await insightRows(raw)).toEqual([])
    expect((await runRows(raw)).map((r) => [r.job, r.status, r.insights])).toEqual([
      ['demand', 'done', 0],
      ['refund-rate', 'done', 0],
      ['stock-runway', 'done', 0],
    ])
  })

  it('AC-13: an import of 60 days of history and a week of live orders that would read as a fall write nothing from demand or refund-rate, while the same week one live day longer does fire demand', async () => {
    const seedImportAndWeek = async (liveFromBack: number) => {
      const order = await seedOrder(k, { source: 'storefront' })
      await applyFigures(k, [
        ...daysRange(60, 1).map((day) => paidOn(day, 10, 'import')),
        ...daysRange(liveFromBack, 1).map((day) => paidOn(day, 10)),
        paidOn(DATA_DAY, 3),
      ])
      for (const back of [0, 1, 2, 3, 4, 5])
        await seedRefund(k, { orderId: order.id, at: noonOf(daysBack(back)) })
    }
    const jobs = [shippedJob('demand'), shippedJob('refund-rate')]

    await seedImportAndWeek(6)
    await runTwice(k, NOW, jobs)
    const guarded = await insightRows(raw)

    await resetNight(k)
    await seedImportAndWeek(7)
    await runTwice(k, NOW, jobs)
    const live = await insightRows(raw)

    expect(guarded.map((r) => `${r.job}/${r.subject}`)).toEqual([])
    expect(live.map((r) => `${r.job}/${r.subject}`)).toEqual(['demand/orders'])
  })
})

describe('AC-18: every number a summary prints is one of its facts', () => {
  const name = fc.stringMatching(/^[A-Z][a-z]{2,8} [1-9][0-9]{0,3}( [a-z]{1,5})?$/)
  const sku = fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,5}$/)
  const term = fc.stringMatching(/^[a-z]{2,8} [1-9][0-9]{0,2}$/)

  it('AC-18: property: for generated product names, SKUs and terms holding digits, and stock and sales that give a fractional runway, every number in each stock-runway and zero-result-term summary occurs in a fact', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          name,
          sku,
          term,
          stock: fc.integer({ min: 1, max: 13 }),
          perDay: fc.integer({ min: 1, max: 3 }),
          searches: fc.integer({ min: 3, max: 40 }),
        }),
        async ({ name: productName, sku: code, term: typed, stock, perDay, searches }) => {
          await clearReports(k)
          const v = await variantWith(stock, productName, code)
          await applyFigures(k, [
            ...sold(v, daysRange(27, 0), perDay),
            searchedOn(DATA_DAY, typed, searches),
          ])

          const stockDrafts = await draftsOf(k, shippedJob('stock-runway'), NOW)
          const termDrafts = await draftsOf(k, shippedJob('zero-result-term'), NOW)

          expect(stockDrafts.map((d) => d.subject)).toEqual([`variant:${v.variantId}`])
          expect(termDrafts.map((d) => d.subject)).toEqual([`term:${typed}`])
          expect(stockDrafts[0]!.facts['daysLeft']).toBe(Math.floor((stock * 28) / (28 * perDay)))
          for (const d of [...stockDrafts, ...termDrafts]) {
            expect(numbersNotInFacts(d.summary, d.facts), d.summary).toEqual([])
          }
        },
      ),
      { numRuns: 25 },
    )
  }, 120_000)
})

// ---- refund rate by product -----------------------------------------------------------------------------------------

interface ProductCase {
  refunds: number
  baselineRefunds: number
  units: number
  baselineUnits: number
  name?: string
}

/**
 * A store that has labelled refunds since before the baseline (one named refund 35 days back, outside both windows)
 * and has sold every day (a product with no refunds), with no paid orders, so the store-wide rule has nothing to
 * compare: each case is a product with its named refunds and units in the week and the four weeks before, and
 * `unnamed` refunds in the week name no product. The products, in the order given.
 */
async function productNight(cases: ProductCase[], unnamed = 0): Promise<SoldVariant[]> {
  const order = await seedOrder(k, { source: 'storefront' })
  const background = await variantWith(1_000, 'Everyday tee')
  const products: SoldVariant[] = cases.map((c) => ({
    variantId: randomUUID(),
    productId: randomUUID(),
    productName: c.name ?? 'Linen shirt',
    sku: `SKU-${randomUUID().slice(0, 6)}`,
  }))
  await applyFigures(k, [
    ...sold(background, daysRange(34, 0), 10),
    ...cases.flatMap((c, i) => [
      ...spreadSold(products[i]!, c.baselineUnits, daysRange(34, 7)),
      ...spreadSold(products[i]!, c.units, daysRange(6, 0)),
    ]),
  ])
  const refund = (p: SoldVariant | null, at: Date) =>
    seedRefund(k, {
      orderId: order.id,
      at,
      ...(p !== null && { variantId: p.variantId, productId: p.productId }),
    })
  await refund(background, noonOf(daysBack(35)))
  for (const [i, c] of cases.entries()) {
    for (let n = 0; n < c.baselineRefunds; n += 1)
      await refund(products[i]!, noonOf(daysBack(30 - (n % 7))))
    for (let n = 0; n < c.refunds; n += 1) await refund(products[i]!, noonOf(daysBack(6 - (n % 7))))
  }
  for (let n = 0; n < unnamed; n += 1) await refund(null, noonOf(daysBack(6 - (n % 7))))
  return products
}

const refundJob = shippedJob('refund-rate')

/** The subjects of the night's product drafts, in the job's order. */
async function productDrafts(): Promise<string[]> {
  return (await draftsOf(k, refundJob, NOW))
    .map((d) => d.subject)
    .filter((subject) => subject.startsWith('product:'))
}

const subjectOf = (p: SoldVariant) => `product:${p.productId}`

describe('AC-9: the by-product rule at its edges', () => {
  // Kills: a strict comparison (exactly twice does not fire) and the ratio turned round (just under twice fires).
  it('AC-9: 4 named refunds on 100 units against 8 on 400 is exactly twice the baseline rate and fires; 7 on 100 against 15 on 400 is just under and does not', async () => {
    const [atTwice] = await productNight([
      { refunds: 4, baselineRefunds: 8, units: 100, baselineUnits: 400 },
    ])
    const twice = await productDrafts()
    await resetNight(k)
    await productNight([{ refunds: 7, baselineRefunds: 15, units: 100, baselineUnits: 400 }])
    const under = await productDrafts()

    expect(twice).toEqual([subjectOf(atTwice!)])
    expect(under).toEqual([])
  })

  // Kills: the minimum off by one or dropped, and a product with no units in either window firing (a rise from zero
  // units, or a division by zero read as a spike).
  it('AC-9: 2 named refunds, no units sold in the week, or none in the baseline writes no product insight, while 3 named refunds on units in both windows does', async () => {
    const cases: ProductCase[] = [
      { refunds: 2, baselineRefunds: 0, units: 100, baselineUnits: 400 },
      { refunds: 4, baselineRefunds: 1, units: 0, baselineUnits: 400 },
      { refunds: 4, baselineRefunds: 0, units: 100, baselineUnits: 0 },
      { refunds: 3, baselineRefunds: 0, units: 100, baselineUnits: 400 },
    ]
    const fired: boolean[] = []
    const others: string[][] = []
    for (const c of cases) {
      await resetNight(k)
      const [p] = await productNight([c])
      const drafted = await productDrafts()
      fired.push(drafted.includes(subjectOf(p!)))
      others.push(drafted.filter((subject) => subject !== subjectOf(p!)))
    }

    expect(fired).toEqual([false, false, false, true])
    expect(others).toEqual(cases.map(() => []))
  })

  // Kills: every refund of the week counted toward each product, so unlabelled refunds lift a product over the line.
  it('AC-9: a refund that names no product counts toward no product: beside a product that fires, one with 2 named and 5 unnamed refunds in the week gets no insight', async () => {
    const [firing] = await productNight(
      [
        { refunds: 4, baselineRefunds: 0, units: 100, baselineUnits: 400 },
        { refunds: 2, baselineRefunds: 0, units: 100, baselineUnits: 400 },
      ],
      5,
    )

    expect(await productDrafts()).toEqual([subjectOf(firing!)])
  })

  // Kills: no cap, the cap keeping the fewest refunds, or a tie at the cut decided by seed order.
  it('AC-9: of six products that fire, the five with the most refunds get an insight, ordered by refunds then product id', async () => {
    const counts = [4, 8, 4, 6, 7, 5]
    const products = await productNight(
      counts.map((refunds) => ({ refunds, baselineRefunds: 0, units: 100, baselineUnits: 400 })),
    )
    const ranked = products
      .map((p, i) => ({ subject: subjectOf(p), id: p.productId, refunds: counts[i]! }))
      .sort((a, b) => b.refunds - a.refunds || (a.id < b.id ? -1 : 1))

    const drafted = await productDrafts()
    await runTwice(k, NOW, [refundJob])
    const rows = await insightRows(raw, 'refund-rate')
    const [run] = (await runRows(raw)).filter((r) => r.job === 'refund-rate')

    expect(drafted).toEqual(ranked.map((r) => r.subject))
    expect(rows.map((r) => r.subject).sort()).toEqual(
      ranked
        .slice(0, 5)
        .map((r) => r.subject)
        .sort(),
    )
    expect(run?.insights).toBe(rows.length)
  })
})

describe('AC-11: every number a product refund summary prints is one of its facts', () => {
  const name = fc.stringMatching(/^[A-Z][a-z]{2,8} [1-9][0-9]{0,3}( [a-z]{1,5})?$/)

  it('AC-11: property: for generated product names holding digits and counts that fire, every number in the product summary occurs in a fact', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          name,
          refunds: fc.integer({ min: 3, max: 9 }),
          units: fc.integer({ min: 1, max: 300 }),
          baselineUnits: fc.integer({ min: 1, max: 900 }),
          pick: fc.nat(),
        }),
        async ({ name: productName, refunds, units, baselineUnits, pick }) => {
          // Any baseline count the rule still fires on: refunds × baselineUnits ≥ 2 × baselineRefunds × units.
          const most = Math.min(20, Math.floor((refunds * baselineUnits) / (2 * units)))
          const baselineRefunds = pick % (most + 1)
          await resetNight(k)
          const [p] = await productNight([
            { refunds, baselineRefunds, units, baselineUnits, name: productName },
          ])

          const drafts = (await draftsOf(k, refundJob, NOW)).filter(
            (d) => d.subject === subjectOf(p!),
          )

          expect(drafts.map((d) => d.facts['productName'])).toEqual([productName])
          expect(numbersNotInFacts(drafts[0]!.summary, drafts[0]!.facts), drafts[0]!.summary).toEqual(
            [],
          )
        },
      ),
      { numRuns: 20 },
    )
  }, 120_000)
})
