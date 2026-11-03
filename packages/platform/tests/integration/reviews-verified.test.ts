import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OrderStatus } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  ALL_STATUSES,
  expectedOrderId,
  PAID,
  productIn,
  reviewer,
  reviewRows,
  writeOrders,
  type OrderSpec,
  type Reviewer,
} from '../support/reviews.js'

// Invariant: a review's orderId is null or the reviewer's own paid purchase of the product. Over HTTP on a served
// SQLite kernel, with orders written straight to the command store at chosen creation times, the review a customer
// submits names their newest order holding the product in confirmed, processing, shipped, delivered or
// partially_refunded, else null; never another customer's order, and never only among their latest page of orders.

let k: Kernel
let served: ServedKernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

const MINUTE = 60_000

interface GeneratedOrder {
  owner: 0 | 1
  status: OrderStatus
  products: number[]
  minutesAgo: number
}

const arbOrders: fc.Arbitrary<GeneratedOrder[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 10_000 }), { maxLength: 14 })
  .chain((ages) =>
    fc.tuple(
      ...ages.map((minutesAgo) =>
        fc.record({
          owner: fc.constantFrom(0 as const, 1 as const),
          status: fc.constantFrom(...ALL_STATUSES),
          products: fc.subarray([0, 1, 2], { minLength: 1 }),
          minutesAgo: fc.constant(minutesAgo),
        }),
      ),
    ),
  )
  // Written in an order unrelated to their creation times.
  .chain((orders) => fc.shuffledSubarray(orders, { minLength: orders.length }))

async function submitted(who: Reviewer, productId: string): Promise<string | null> {
  const res = await who.submit({ productId, rating: 5, title: 'Bought it', body: 'As described.' })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!.review.orderId
}

describe('a review names the reviewer’s own paid purchase, or nothing', () => {
  // Kills: a pending, cancelled or refunded order counting; another customer's order matching; the oldest rather than
  // the newest match.
  it('AC-5: property: over generated orders of two customers (statuses across every order status, lines over three products, creation times shuffled), each customer’s review names their newest order holding the product in a paid status, else null, and the stored row says the same', async () => {
    const customers = [await reviewer(served.baseUrl), await reviewer(served.baseUrl)] as const
    await fc.assert(
      fc.asyncProperty(arbOrders, fc.integer({ min: 0, max: 2 }), async (generated, reviewed) => {
        const products = [
          await productIn(k, 'active'),
          await productIn(k, 'active'),
          await productIn(k, 'active'),
        ]
        const now = Date.now()
        const specs: OrderSpec[] = generated.map((o) => ({
          customerId: customers[o.owner].id,
          status: o.status,
          productIds: o.products.map((i) => products[i]!),
          createdAt: new Date(now - o.minutesAgo * MINUTE),
        }))
        const ids = await writeOrders(k, specs)
        const orders = specs.map((spec, i) => ({ ...spec, id: ids[i]! }))
        const productId = products[reviewed]!

        for (const who of customers) {
          const expected = expectedOrderId(orders, who.id, productId)
          const label = `${who.id === customers[0].id ? 'first' : 'second'} customer: ${JSON.stringify(
            orders.map((o) => [
              o.customerId === who.id,
              o.status,
              o.productIds.includes(productId),
            ]),
          )}`

          const orderId = await submitted(who, productId)

          expect(orderId, label).toBe(expected)
          const owner = orders.find((o) => o.id === orderId)?.customerId ?? null
          expect(orderId === null ? null : owner, label).toBe(orderId === null ? null : who.id)
          expect(
            (await reviewRows(raw, productId, who.id)).map((r) => r.orderId),
            label,
          ).toEqual([expected])
        }
      }),
      { numRuns: 20 },
    )
  }, 180_000)

  // Kills: only the customer's first page of orders read (`listByCustomer`'s 50), so a long-standing customer's
  // purchase reads as unverified.
  it('AC-5: a customer whose only paid order holding the product is older than their 60 newest orders gets that order; their newer orders hold the product only as pending, cancelled or refunded, or hold other products', async () => {
    const who = await reviewer(served.baseUrl)
    const productId = await productIn(k, 'active')
    const other = await productIn(k, 'active')
    const now = Date.now()
    const unpaid: OrderStatus[] = ['pending', 'cancelled', 'refunded']
    const newer: OrderSpec[] = Array.from({ length: 60 }, (_, i) => ({
      customerId: who.id,
      status: i % 2 === 0 ? unpaid[i % 3]! : PAID[i % PAID.length]!,
      productIds: i % 2 === 0 ? [productId, other] : [other],
      createdAt: new Date(now - (i + 1) * MINUTE),
    }))
    const oldest: OrderSpec = {
      customerId: who.id,
      status: 'delivered',
      productIds: [productId],
      createdAt: new Date(now - 24 * 60 * MINUTE),
    }
    // The old purchase is written first, the newer orders after it, newest last.
    const [purchase] = await writeOrders(k, [oldest, ...newer.reverse()])
    const all = [oldest, ...newer]
    expect(all.filter((o) => o.createdAt > oldest.createdAt).length).toBe(60)

    const orderId = await submitted(who, productId)

    expect(orderId).toBe(purchase)
    expect((await reviewRows(raw, productId, who.id)).map((r) => r.orderId)).toEqual([purchase])
  })
})
