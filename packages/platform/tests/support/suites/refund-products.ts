import { randomUUID } from 'node:crypto'
import type { Order } from '@nymbalhq/types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Kernel } from '../kernel.js'
import {
  DATA_DAY,
  NOW,
  applyFigures,
  daysBack,
  daysRange,
  insightEvents,
  insightRows,
  noonOf,
  resetNight,
  runTwice,
  seedRefund,
  shippedJob,
  soldOn,
  spreadPaid,
  spreadSold,
  type SoldVariant,
} from '../night-shift.js'
import { openRaw, type RawReader } from '../raw.js'
import { seedOrder } from '../report-rollups.js'

// The refund-rate job by product on one dialect: refunds that name a product are counted per product against its units
// sold in the rollups, the week against the four weeks before, once the store has labelled refunds for that long; the
// store-wide rule runs over what no firing product accounts for. Refunds go in through the repository, units and paid
// orders through the rollup repository; the night runs twice and the insights are read back on a second connection.

interface ProductFacts {
  productId: string
  productName: string
  refunds: number
  unitsSold: number
  ratePercent: number
  baselineRefunds: number
  baselineUnitsSold: number
  baselineRatePercent: number
}

const percent = (n: number, of: number) => Math.round((n / of) * 100 * 10) / 10

function productFacts(
  p: SoldVariant,
  figures: {
    refunds: number
    unitsSold: number
    baselineRefunds: number
    baselineUnitsSold: number
  },
): ProductFacts {
  return {
    productId: p.productId,
    productName: p.productName,
    refunds: figures.refunds,
    unitsSold: figures.unitsSold,
    ratePercent: percent(figures.refunds, figures.unitsSold),
    baselineRefunds: figures.baselineRefunds,
    baselineUnitsSold: figures.baselineUnitsSold,
    baselineRatePercent: percent(figures.baselineRefunds, figures.baselineUnitsSold),
  }
}

const sentence = (f: ProductFacts) =>
  `Refunds of "${f.productName}" rose to ${f.refunds} in the week to yesterday ` +
  `(${f.ratePercent}% of ${f.unitsSold} units sold), against ${f.baselineRefunds} ` +
  `(${f.baselineRatePercent}% of ${f.baselineUnitsSold}) in the four weeks before.`

export function refundProductsSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
): void {
  describe(`refunds by product (${dialect})`, () => {
    let k: Kernel
    let raw: RawReader

    beforeAll(async () => {
      k = await start()
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    beforeEach(async () => {
      await resetNight(k)
    })

    afterAll(async () => {
      await raw?.close()
      await k?.close()
    })

    const product = (name: string): SoldVariant => ({
      variantId: randomUUID(),
      productId: randomUUID(),
      productName: name,
      sku: `SKU-${randomUUID().slice(0, 6)}`,
    })

    /** Storefront paid orders over the 28 baseline days and the 7 days of the week. */
    const paid = (baseline: number, week: number) => [
      ...spreadPaid(baseline, daysRange(34, 7)),
      ...spreadPaid(week, daysRange(6, 0)),
    ]

    /** Storefront units of `p` over the 28 baseline days and the 7 days of the week. */
    const units = (p: SoldVariant, baseline: number, week: number) => [
      ...spreadSold(p, baseline, daysRange(34, 7)),
      ...spreadSold(p, week, daysRange(6, 0)),
    ]

    /** `n` succeeded admin refunds of `order` naming `p` (none when null), one a day back from `fromBack`. */
    async function refunds(
      order: Order,
      p: SoldVariant | null,
      n: number,
      fromBack: number,
    ): Promise<void> {
      for (let i = 0; i < n; i += 1) {
        await seedRefund(k, {
          orderId: order.id,
          at: noonOf(daysBack(fromBack - (i % 7))),
          ...(p !== null && { variantId: p.variantId, productId: p.productId }),
        })
      }
    }

    /** One refund naming `p` at `at`: the store's earliest labelled refund in these fixtures. */
    const firstNamed = (order: Order, p: SoldVariant, at: Date) =>
      seedRefund(k, { orderId: order.id, at, variantId: p.variantId, productId: p.productId })

    async function refundNight() {
      await runTwice(k, NOW, [shippedJob('refund-rate')])
      return {
        rows: await insightRows(raw, 'refund-rate'),
        events: await insightEvents(raw, 'refund-rate'),
      }
    }

    describe('AC-8: a product whose refunds rose gets one insight naming it', () => {
      // Kills: the job staying store-wide, the control product firing, units counted from an import or from one source
      // or currency only, a name from before the week, and the same refunds reported again as a store insight.
      it(`AC-8: with named refunds reaching back past the baseline, product X at 4 named refunds on 100 units in the week against 1 on 400 before, and Y at 2, makes exactly one insight, product:X, with its facts and sentence, and no store insight; the night run twice leaves one (${dialect})`, async () => {
        const order = await seedOrder(k, { source: 'storefront' })
        const x = product('Linen shirt')
        const y = product('Wool scarf')
        await applyFigures(k, [
          ...paid(400, 100),
          // X was renamed this week: the insight names it as the week's rollups do.
          ...spreadSold({ ...x, productName: 'Linen shirt (old)' }, 400, daysRange(34, 7)),
          // The week's 100 units over two sources and two currencies.
          ...spreadSold(x, 70, daysRange(6, 0)),
          ...spreadSold(x, 20, daysRange(6, 0), 'agent:shop-bot'),
          Object.assign(soldOn(DATA_DAY, x, 10), { currency: 'EUR' }),
          // An import's units say nothing about the week's shoppers; counted, they would hide X's rise (4 × 400 is
          // under 2 × 1 × 1,100).
          soldOn(daysBack(3), x, 1_000, 'import'),
          ...units(y, 400, 100),
        ])
        await firstNamed(order, x, noonOf(daysBack(35)))
        await refunds(order, x, 1, 30)
        await refunds(order, x, 4, 6)
        await refunds(order, y, 2, 6)

        const { rows, events } = await refundNight()

        const facts = productFacts(x, {
          refunds: 4,
          unitsSold: 100,
          baselineRefunds: 1,
          baselineUnitsSold: 400,
        })
        // 6 counted refunds in the week less X's 4 leave 2, under the store rule's 5.
        expect(rows.map((r) => r.subject)).toEqual([`product:${x.productId}`])
        expect(rows[0]!.facts).toEqual(facts)
        expect(rows[0]!.summary).toBe(sentence(facts))
        expect(rows[0]!.severity).toBe('warning')
        expect(events.map((e) => e.insightId)).toEqual(rows.map((r) => r.id))
      })
    })

    describe('AC-10: the product rule waits for labelled history, and the store rule covers what it does not', () => {
      // Kills: the wait read in UTC or against the week rather than the baseline (a store's first labelled refunds read
      // as a rise against weeks that had none), and labelled refunds dropped from the store count when no product fires.
      it(`AC-10: with the earliest named refund on the baseline's first day in store time a product fires; with it a store day later no product insight is written however the week rises; on either night no product fires the store insight counts named and unnamed refunds alike (${dialect})`, async () => {
        const night = async (firstAt: Date, week: { named: number; unnamed: number }) => {
          await resetNight(k)
          const order = await seedOrder(k, { source: 'storefront' })
          const x = product('Linen shirt')
          await applyFigures(k, [...paid(400, 100), ...units(x, 400, 100)])
          await firstNamed(order, x, firstAt)
          await refunds(order, x, week.named, 6)
          await refunds(order, null, week.unnamed, 6)
          const { rows } = await refundNight()
          return { x, rows }
        }
        const storeFacts = (refunds: number) => ({
          refunds,
          paidOrders: 100,
          baselineRefunds: 1,
          baselinePaidOrders: 400,
        })

        // 23:30 UTC is 00:30 BST the next day: the first on the baseline's first day, the second a day inside it. Either
        // way the first named refund is the one refund of the baseline.
        const onBoundary = await night(new Date(`${daysBack(35)}T23:30:00.000Z`), {
          named: 4,
          unnamed: 0,
        })
        const tooYoung = await night(new Date(`${daysBack(34)}T23:30:00.000Z`), {
          named: 6,
          unnamed: 0,
        })
        // Labelled long enough, but 2 named refunds are under the product minimum: 2 named and 3 unnamed make 5.
        const underMinimum = await night(new Date(`${daysBack(35)}T23:30:00.000Z`), {
          named: 2,
          unnamed: 3,
        })

        expect(onBoundary.rows.map((r) => r.subject)).toEqual([`product:${onBoundary.x.productId}`])
        expect(onBoundary.rows[0]!.facts['baselineRefunds']).toBe(1)
        expect(tooYoung.rows.map((r) => r.subject)).toEqual(['store'])
        expect(tooYoung.rows[0]!.facts).toMatchObject(storeFacts(6))
        expect(underMinimum.rows.map((r) => r.subject)).toEqual(['store'])
        expect(underMinimum.rows[0]!.facts).toMatchObject(storeFacts(5))
      })

      // Kills: a product insight silencing a store-wide spike of unlabelled refunds, or the store insight counting the
      // product's refunds a second time.
      it(`AC-10: a product fires and the unlabelled refunds alone pass the store rule: both insights are written, the store one counting only the refunds no firing product names (${dialect})`, async () => {
        const order = await seedOrder(k, { source: 'storefront' })
        const x = product('Linen shirt')
        await applyFigures(k, [...paid(400, 100), ...units(x, 400, 100)])
        await firstNamed(order, x, noonOf(daysBack(35)))
        await refunds(order, x, 1, 30)
        await refunds(order, x, 4, 6)
        await refunds(order, null, 5, 6)

        const { rows, events } = await refundNight()

        expect(rows.map((r) => r.subject)).toEqual([`product:${x.productId}`, 'store'])
        expect(rows[0]!.facts).toEqual(
          productFacts(x, {
            refunds: 4,
            unitsSold: 100,
            baselineRefunds: 1,
            baselineUnitsSold: 400,
          }),
        )
        expect(rows[1]!.facts).toMatchObject({
          refunds: 5,
          paidOrders: 100,
          baselineRefunds: 1,
          baselinePaidOrders: 400,
        })
        expect(events.map((e) => e.insightId).sort()).toEqual(rows.map((r) => r.id).sort())
      })
    })
  })
}
