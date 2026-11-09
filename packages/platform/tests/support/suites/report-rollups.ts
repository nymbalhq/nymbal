import { v7 as uuidv7 } from 'uuid'
import fc from 'fast-check'
import type { NymbalEvent, OrderLineItem } from '@nymbalhq/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROLLUP_EVENT_TYPES, recompute } from '../../../src/reports/fold.js'
import { address, seedVariant, type Kernel } from '../kernel.js'
import { eventRows } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'
import {
  AROUND_CLOCK_CHANGE,
  ZONE,
  canonicalRollups,
  clearReports,
  deliver,
  deliveryOrders,
  rollupEventArb,
  seedPool,
  storedRollups,
  type Pool,
} from '../report-rollups.js'

// The rollup on one dialect: what any sequence of events, delivered in any order with any repeats, leaves in the report
// tables is what a recompute of those events gives; and an imported order taken back out leaves its original day as
// if it had never been there.

export function reportRollupSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  numRuns: number,
): void {
  describe(`AC-8: the rollup equals a recompute (${dialect})`, () => {
    let k: Kernel
    let raw: RawReader
    let pool: Pool

    beforeAll(async () => {
      k = await start()
      raw = openRaw(k.dialect, k.target)
      pool = await seedPool(k)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await k?.close()
    })

    it(`AC-8: property: any sequence of rollup events across days, currencies and sources, delivered in any order with any repeats, leaves the report tables equal to a recompute of those events (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .array(rollupEventArb(pool, AROUND_CLOCK_CHANGE), { minLength: 1, maxLength: 14 })
            .chain((events) =>
              fc.record({ events: fc.constant(events), order: deliveryOrders(events.length) }),
            ),
          async ({ events, order }) => {
            await clearReports(k)
            for (const i of order) await deliver(k, events[i]!)

            const expected = canonicalRollups(recompute(events, pool.lookup, ZONE))
            expect(await storedRollups(raw)).toEqual(expected)
          },
        ),
        { numRuns },
      )
    }, 180_000)
  })

  describe(`AC-16: removing an imported order subtracts it (${dialect})`, () => {
    let k: Kernel
    let raw: RawReader

    beforeAll(async () => {
      k = await start()
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await k?.close()
    })

    async function loggedRollupEvents(): Promise<NymbalEvent<unknown>[]> {
      const types: readonly string[] = ROLLUP_EVENT_TYPES
      return (await eventRows(raw))
        .filter((row) => types.includes(row.type))
        .map((row) => row.envelope)
    }

    async function salesOf(day: string) {
      const [row] = await raw.rows<{ captured: unknown; refunded: unknown; paid: unknown }>(
        `SELECT COALESCE(SUM(captured_minor), 0) AS captured, COALESCE(SUM(refunded_minor), 0) AS refunded,
                COALESCE(SUM(paid_orders), 0) AS paid
         FROM report_sales_hours WHERE local_day = ?`,
        [day],
      )
      return [Number(row!.captured), Number(row!.refunded), Number(row!.paid)]
    }

    it(`AC-16: an imported order’s figures sit on its own day until it is removed; after removal the day holds nothing and the rollup still equals a recompute of the log (${dialect})`, async () => {
      await clearReports(k)
      const seeded = await seedVariant(k, 5)
      const line: OrderLineItem = {
        variantId: seeded.variantId,
        productId: seeded.productId,
        productName: 'Imported Widget',
        variantName: 'Default',
        sku: 'IMP-1',
        qty: 3,
        unitPriceMinor: 1000,
        lineSubtotalMinor: 3000,
        lineTaxMinor: 0,
        lineTotalMinor: 3000,
        imageUrl: '',
      }
      const orderId = uuidv7()
      const day = '2026-08-01'

      await k.services.order.importOrder({
        orderId,
        orderNumber: `WC-${orderId.slice(-8)}`,
        status: 'processing',
        customerId: null,
        email: `imported-${orderId}@reports.test`,
        billingAddress: address,
        shippingAddress: address,
        lineItems: [line],
        subtotalMinor: 3000,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor: 3000,
        currency: 'GBP',
        metadata: { woocommerce: { orderId: 1 } },
        createdAt: new Date(`${day}T12:00:00.000Z`),
        capturedMinor: 3000,
        refundedMinor: 500,
        captureMethod: 'import',
      })
      await k.app.relay.drain()
      expect(await salesOf(day)).toEqual([3000, 500, 1])

      await expect(k.services.importRemoval.removeOrder(orderId)).resolves.toBe('removed')
      await k.app.relay.drain()

      expect(await salesOf(day)).toEqual([0, 0, 0])
      const [units] = await raw.rows<{ units: unknown }>(
        'SELECT COALESCE(SUM(units), 0) AS units FROM report_product_days WHERE local_day = ?',
        [day],
      )
      expect(Number(units!.units)).toBe(0)
      const stored = await storedRollups(raw)
      const expected = canonicalRollups(
        recompute(
          await loggedRollupEvents(),
          { orderOf: () => null, cartSourceOf: () => null },
          ZONE,
        ),
      )
      expect(stored).toEqual(expected)
    })
  })
}
