import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OrderLineItem } from '@nymbalhq/types'
import { address, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { lineFor } from '../support/replica.js'

// P1-05 AC-9: the arithmetic of an order placed through checkout, as relations between its own fields, over carts of
// several lines. Sentinel I103 (a line total one minor unit high) runs this file. Kills: any line or order total that
// is not the sum of what it is made of.

const arbLines = fc.array(
  fc.record({
    priceMinor: fc.integer({ min: 1, max: 99_999 }),
    qty: fc.integer({ min: 1, max: 9 }),
  }),
  { minLength: 2, maxLength: 5 },
)

describe('order arithmetic', () => {
  let k: Kernel

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
  }, 60_000)

  afterAll(async () => {
    await k?.close()
  })

  it('AC-9: per line, lineSubtotalMinor = unitPriceMinor × qty and lineTotalMinor = lineSubtotalMinor + lineTaxMinor; for the order, subtotal, tax total and total are the sums the type promises', async () => {
    await fc.assert(
      fc.asyncProperty(arbLines, async (lines) => {
        const cart = await k.services.cart.getOrCreate()
        for (const line of lines) {
          const seeded = await seedVariant(k, line.qty + 1, { priceMinor: line.priceMinor })
          await k.services.cart.addItem(cart.token, lineFor(seeded, line.qty))
        }
        const started = await k.services.checkout.beginCheckout({
          cartToken: cart.token,
          email: `arith-${randomUUID()}@p1-05.test`,
          billingAddress: address,
          shippingAddress: address,
        })
        const order = await k.store.read((tx) => k.repos.order.findById(tx, started.orderId))
        if (!order) throw new Error(`order ${started.orderId} not found`)

        expect(order.lineItems).toHaveLength(lines.length)
        for (const item of order.lineItems) {
          expect(Number.isInteger(item.unitPriceMinor)).toBe(true)
          expect(item.lineSubtotalMinor).toBe(item.unitPriceMinor * item.qty)
          expect(item.lineTotalMinor).toBe(item.lineSubtotalMinor + item.lineTaxMinor)
        }
        const sum = (pick: (i: OrderLineItem) => number) =>
          order.lineItems.reduce((acc, i) => acc + pick(i), 0)
        expect(order.subtotalMinor).toBe(sum((i) => i.lineSubtotalMinor))
        expect(order.taxTotalMinor).toBe(sum((i) => i.lineTaxMinor))
        expect(order.totalMinor).toBe(
          order.subtotalMinor +
            order.taxTotalMinor +
            order.shippingTotalMinor -
            order.discountTotalMinor,
        )
        expect(started.totalMinor).toBe(order.totalMinor)
      }),
      { numRuns: 6 },
    )
  }, 120_000)
})
