import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { paymentState, type OrderStatus } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import type { Kernel } from '../kernel.js'
import {
  productIn,
  reviewer,
  writeOrders,
  type OrderSpec,
  type Reviewer,
} from '../reviews.js'

// A review's orderId on one dialect, through `POST /api/reviews` and the page loop of `newestHolding`: a fully refunded
// order never verifies, at any status; a partially refunded or paid one does; so does a delivered import that captured
// nothing, as it did before.

const VERIFYING: readonly OrderStatus[] = ['confirmed', 'processing', 'shipped', 'delivered']
const TOTAL = 1500

type Money = 'none' | 'paid' | 'partial' | 'full'
const moneyOf = (m: Money): { capturedMinor: number; refundedMinor: number } =>
  m === 'none'
    ? { capturedMinor: 0, refundedMinor: 0 }
    : m === 'paid'
      ? { capturedMinor: TOTAL, refundedMinor: 0 }
      : m === 'partial'
        ? { capturedMinor: TOTAL, refundedMinor: 400 }
        : { capturedMinor: TOTAL, refundedMinor: TOTAL }

export function reviewVerifiedMoneySuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: { runs: number },
): void {
  describe(`AC-10: a verified review needs a purchase not refunded in full (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
    }, 60_000)

    afterAll(async () => {
      await served?.stop()
    })

    const submit = async (who: Reviewer, productId: string): Promise<string | null> => {
      const res = await who.submit({
        productId,
        rating: 5,
        title: 'Bought it',
        body: 'As described.',
      })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.data!.review.orderId
    }

    const MINUTE = 60_000
    const arbOrder = fc.record({
      status: fc.constantFrom<OrderStatus>(...VERIFYING, 'pending', 'cancelled'),
      money: fc.constantFrom<Money>('none', 'paid', 'partial', 'full'),
      holds: fc.boolean(),
      minutesAgo: fc.integer({ min: 1, max: 10_000 }),
    })

    // Defect: a status-only list verifies a refunded delivered order; or a partial refund stops verifying.
    it(`AC-10: property: a review names the newest order holding the product at a verifying status not refunded in full; orders refunded in full at any status never verify, partially refunded, paid and delivered imports with nothing captured do, otherwise null (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(arbOrder, { maxLength: 8 }), async (orders) => {
          const who = await reviewer(served.baseUrl)
          const productId = await productIn(k, 'active')
          const other = await productIn(k, 'active')
          const now = Date.now()
          // Unique ages: a tie would make the expected order depend on the id.
          const specs: Array<OrderSpec & { money: Money }> = orders.map((o, i) => ({
            customerId: who.id,
            status: o.status,
            productIds: o.holds ? [productId] : [other],
            createdAt: new Date(now - (o.minutesAgo + i) * MINUTE * 100),
            money: o.money,
            ...moneyOf(o.money),
          }))
          const ids = await writeOrders(k, specs)
          const newestIndex = specs
            .map((spec, i) => ({ spec, i }))
            .filter(({ spec }) => spec.productIds.includes(productId))
            .filter(({ spec }) => VERIFYING.includes(spec.status))
            .filter(({ spec }) => paymentState(moneyOf(spec.money)) !== 'refunded')
            .sort((a, b) => b.spec.createdAt.getTime() - a.spec.createdAt.getTime())[0]?.i
          const expected = newestIndex === undefined ? null : ids[newestIndex]!

          expect(
            await submit(who, productId),
            JSON.stringify(specs.map((s) => [s.status, s.money, s.productIds[0] === productId])),
          ).toBe(expected)
        }),
        { numRuns: opts.runs },
      )
    }, 180_000)

    // Defect: the page loop stops at the first page of statuses, so a buyer whose newer orders were all refunded reads
    // as unverified.
    it(`AC-10: a customer whose 60 newest orders holding the product were all fully refunded, at confirmed and delivered, gets the older paid order; a delivered import with nothing captured verifies, and a fully refunded delivered order alone gives null (${dialect})`, async () => {
      const who = await reviewer(served.baseUrl)
      const productId = await productIn(k, 'active')
      const now = Date.now()
      const refunded: OrderSpec[] = Array.from({ length: 60 }, (_, i) => ({
        customerId: who.id,
        status: i % 2 === 0 ? 'confirmed' : 'delivered',
        productIds: [productId],
        createdAt: new Date(now - (i + 1) * MINUTE),
        ...moneyOf('full'),
      }))
      const older: OrderSpec = {
        customerId: who.id,
        status: 'delivered',
        productIds: [productId],
        createdAt: new Date(now - 24 * 60 * MINUTE),
        ...moneyOf('paid'),
      }
      const [purchase] = await writeOrders(k, [older, ...refunded])
      const importedBuyer = await reviewer(served.baseUrl)
      const [imported] = await writeOrders(k, [
        {
          customerId: importedBuyer.id,
          status: 'delivered',
          productIds: [productId],
          createdAt: new Date(now),
          ...moneyOf('none'),
        },
      ])
      const refundedOnly = await reviewer(served.baseUrl)
      await writeOrders(k, [
        {
          customerId: refundedOnly.id,
          status: 'delivered',
          productIds: [productId],
          createdAt: new Date(now),
          ...moneyOf('full'),
        },
      ])

      expect([
        await submit(who, productId),
        await submit(importedBuyer, productId),
        await submit(refundedOnly, productId),
      ]).toEqual([purchase, imported, null])
    }, 120_000)
  })
}
