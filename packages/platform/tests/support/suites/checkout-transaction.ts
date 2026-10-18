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
import { createCheckoutService } from '../../../src/services/checkout-service.js'
import { address, checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import { lineFor } from '../replica.js'

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

    it('AC-10: a cart of two variants whose second reservation is refused fails beginCheckout with CheckoutError; afterwards both stocks are unchanged, no reservation, order or stock-adjustment row, and no inventory.reserved.v1 or inventory.released.v1', async () => {
      const first = await seedVariant(k, 1, { priceMinor: 500 })
      const second = await seedVariant(k, 1, { priceMinor: 800 })
      const variantIds = [first.variantId, second.variantId]
      const events: string[] = []
      await k.eventBus.subscribe([EVT_INVENTORY_RESERVED, EVT_INVENTORY_RELEASED], (event) => {
        if (variantIds.includes((event as WithVariant).payload.variantId)) events.push(event.type)
      })
      // One line per variant is a cart invariant, so the failing second reservation comes from an inventory that
      // refuses its second call; the first call's row and decrement ran inside the same transaction.
      let reservations = 0
      const inventory: Kernel['services']['inventory'] = {
        ...k.services.inventory,
        async reserveStock(...args) {
          reservations += 1
          if (reservations === 2) throw new Error('second reservation refused')
          return k.services.inventory.reserveStock(...args)
        },
      }
      const checkout = createCheckoutService({
        store: k.store,
        repos: k.repos,
        publisher: k.publisher,
        logger: k.logger,
        cart: k.services.cart,
        orders: k.services.order,
        inventory,
        payments: k.app.adapters.payments,
        currency: k.config.store.currency,
      })
      const cart = await k.services.cart.getOrCreate()
      await k.services.cart.addItem(cart.token, lineFor(first, 1))
      await k.services.cart.addItem(cart.token, lineFor(second, 1))
      const email = `refused-${randomUUID()}@p1-02.test`

      await expect(
        checkout.beginCheckout({
          cartToken: cart.token,
          email,
          billingAddress: address,
          shippingAddress: address,
        }),
      ).rejects.toBeInstanceOf(CheckoutError)

      expect(reservations).toBe(2)
      expect(events).toEqual([])
      expect(await stockOf(raw, first.variantId)).toBe(first.initialStock)
      expect(await stockOf(raw, second.variantId)).toBe(second.initialStock)
      expect({
        reservations: await raw.count('inventory_reservations', 'variant_id IN (?, ?)', variantIds),
        orders: await raw.count('orders', 'email = ?', [email]),
        adjustments: await raw.count('stock_adjustments', 'variant_id IN (?, ?)', variantIds),
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
