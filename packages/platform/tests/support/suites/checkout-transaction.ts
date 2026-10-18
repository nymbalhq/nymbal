import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CheckoutError,
  EVT_INVENTORY_RELEASED,
  EVT_INVENTORY_RESERVED,
  EVT_ORDER_PAID,
  type NymbalEvent,
} from '@nymbalhq/types'
import { address, checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'

// P1-02 AC-6, AC-10 and AC-11 on one dialect: finalize's inner service calls join its transaction, beginCheckout
// does its database work in one transaction, and finalize finds its order by payment intent through an index.

type WithVariant = NymbalEvent<{ variantId: string }>
type Paid = NymbalEvent<{ orderId: string }>

export function checkoutTransactionSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: { thousandPendingOrders: boolean },
): void {
  describe(`checkout transactions (${dialect})`, () => {
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

    it('AC-6: finalize where orders.updateStatus throws leaves the reservation rows present, the order pending, no stock-adjustment row and no order.paid.v1', async () => {
      const seeded = await seedVariant(k, 5)
      const qty = 2
      const started = await checkoutOf(k, seeded, qty)
      const paid: Paid[] = []
      await k.eventBus.subscribe(EVT_ORDER_PAID, (event) => {
        if ((event as Paid).payload.orderId === started.orderId) paid.push(event as Paid)
      })

      const original = k.repos.orderHistory.append
      k.repos.orderHistory.append = async () => {
        throw new Error('history unavailable')
      }
      try {
        await expect(
          k.services.checkout.finalize(started.paymentIntent.id, started.totalMinor),
        ).rejects.toThrow('history unavailable')
      } finally {
        k.repos.orderHistory.append = original
      }

      const reservations = await raw.rows<{ qty: number }>(
        'SELECT qty FROM inventory_reservations WHERE variant_id = ?',
        [seeded.variantId],
      )
      expect(reservations.map((r) => Number(r.qty))).toEqual([qty])
      const order = await raw.one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [
        started.orderId,
      ])
      expect(order.status).toBe('pending')
      expect(await raw.count('stock_adjustments', 'variant_id = ?', [seeded.variantId])).toBe(0)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
      expect(paid).toEqual([])
    })

    it('AC-10: a cart holding the same variant twice at qty 1 with stock 1 fails beginCheckout with CheckoutError; afterwards stock 1, no reservation, order or stock-adjustment row, and no inventory.reserved.v1 or inventory.released.v1', async () => {
      const seeded = await seedVariant(k, 1, { priceMinor: 500 })
      const events: string[] = []
      await k.eventBus.subscribe([EVT_INVENTORY_RESERVED, EVT_INVENTORY_RELEASED], (event) => {
        if ((event as WithVariant).payload.variantId === seeded.variantId) events.push(event.type)
      })
      const cart = await k.services.cart.getOrCreate()
      const line = {
        variantId: seeded.variantId,
        productId: seeded.productId,
        productName: 'Transactional Widget',
        variantName: 'Default',
        priceMinor: seeded.priceMinor,
        imageUrl: '',
        qty: 1,
      }
      // Two lines for one variant: addItem would merge them, so the document is written directly (the shape of
      // checkout-service.test.ts). Pre-validation passes (1 <= 1); the second decrement must fail.
      await k.documentStore.put(
        'carts',
        cart.token,
        {
          token: cart.token,
          customerId: null,
          currency: 'GBP',
          subtotalMinor: 2 * seeded.priceMinor,
          expiresAt: cart.expiresAt,
          createdAt: cart.createdAt,
          updatedAt: cart.updatedAt,
          items: [line, line],
        },
        { ttl: 3600 },
      )
      const email = `twice-${randomUUID()}@p1-02.test`

      await expect(
        k.services.checkout.beginCheckout({
          cartToken: cart.token,
          email,
          billingAddress: address,
          shippingAddress: address,
        }),
      ).rejects.toBeInstanceOf(CheckoutError)

      expect(events).toEqual([])
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock)
      expect({
        reservations: await raw.count('inventory_reservations', 'variant_id = ?', [
          seeded.variantId,
        ]),
        orders: await raw.count('orders', 'email = ?', [email]),
        adjustments: await raw.count('stock_adjustments', 'variant_id = ?', [seeded.variantId]),
      }).toEqual({ reservations: 0, orders: 0, adjustments: 0 })
    })

    if (opts.thousandPendingOrders) {
      it('AC-11: with 1001 pending orders, finalize finds the one created first by its payment intent', async () => {
        const seeded = await seedVariant(k, 5)
        const first = await checkoutOf(k, seeded, 1)
        // The lookup under test must not hinge on created_at ties with the fillers: let the clock tick first.
        const startedAt = Date.now()
        while (Date.now() <= startedAt) await new Promise((resolve) => setImmediate(resolve))

        // One transaction for the fillers: the service calls join it, so the batch is one commit.
        const fillers = 1000
        await k.store.transaction(async () => {
          for (let i = 0; i < fillers; i += 1) {
            await k.services.order.createFromCheckout({
              orderId: uuidv7(),
              customerId: null,
              email: `filler-${i}@p1-02.test`,
              billingAddress: address,
              shippingAddress: address,
              lineItems: [],
              subtotalMinor: 0,
              taxTotalMinor: 0,
              shippingTotalMinor: 0,
              discountTotalMinor: 0,
              totalMinor: 0,
              currency: 'GBP',
              metadata: {},
              paymentIntentId: `pi_filler_${i}`,
            })
          }
        })
        expect(await raw.count('orders', "status = 'pending'")).toBeGreaterThanOrEqual(fillers + 1)

        const result = await k.services.checkout.finalize(first.paymentIntent.id, first.totalMinor)

        expect(result.orderNumber).toBe(first.orderNumber)
        const row = await raw.one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [
          first.orderId,
        ])
        expect(row.status).toBe('confirmed')
      }, 120_000)
    }

    if (dialect === 'sqlite') {
      it('AC-11: EXPLAIN QUERY PLAN for the payment-intent lookup names orders_payment_intent_idx', async () => {
        const plan = await raw.rows<{ detail: string }>(
          'EXPLAIN QUERY PLAN SELECT * FROM orders WHERE payment_intent_id = ?',
          ['pi_explain'],
        )
        expect(plan.map((row) => row.detail).join('\n')).toMatch(/orders_payment_intent_idx/)
      })
    } else {
      it('AC-11: pg_indexes lists orders_payment_intent_idx on orders after migrations', async () => {
        const indexes = await raw.rows<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE tablename = 'orders' ORDER BY indexname",
        )
        expect(indexes.map((row) => row.indexname)).toContain('orders_payment_intent_idx')
      })
    }
  })
}
