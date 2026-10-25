import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Cart, PaymentsAdapter } from '@nymbalhq/types'
import { createCheckoutService } from '../../src/services/checkout-service.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import {
  address,
  cartWith,
  checkoutOf,
  createKernel,
  seedVariant,
  type Kernel,
} from '../support/kernel.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import { failedFor, orderStatus, paidFor, reservationsFor } from '../support/webhooks.js'

// AC-1 and AC-4 on SQLite, a kernel from `src/` served over HTTP. With the stub, POST /api/checkout pays inline and
// the order, cart and stock agree, over generated carts; `+stub-decline` cancels the order and gives its stock back;
// a captured intent whose stock another order took is `failed` with stock_unavailable, never a confirmed order.

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  paymentIntent: { id: string; clientSecret: string; status: string }
  currency: string
  totalMinor: number
  orderStatus: string
  payment: { status: 'succeeded' | 'requires_action' | 'failed'; reason?: string }
  orderKey: string
}

const arbLines = fc.array(
  fc.record({
    priceMinor: fc.integer({ min: 1, max: 50_000 }),
    qty: fc.integer({ min: 1, max: 4 }),
    spare: fc.integer({ min: 0, max: 3 }),
  }),
  { minLength: 1, maxLength: 3 },
)

describe('a checkout that completes (sqlite)', () => {
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

  async function shopperWith(lines: Array<{ variantId: string; qty: number }>) {
    const shop = await primedShopper(served.baseUrl)
    const opened = await shop.call<Cart>('GET', '/api/cart')
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    for (const line of lines) {
      const added = await shop.call<Cart>('POST', '/api/cart/items', line)
      expect(added.status, JSON.stringify(added.body)).toBe(200)
    }
    return shop
  }

  function submit(shop: Awaited<ReturnType<typeof shopperWith>>, email: string) {
    return shop.call<CheckoutAnswer>('POST', '/api/checkout', {
      email,
      billingAddress: address,
      shippingAddress: address,
    })
  }

  // Kills: the stub order staying pending, the cart kept after the payment, and stock committed twice (a reservation
  // decrement and then a second one at confirm).
  it('AC-1: over generated carts, the stub checkout answers succeeded and confirmed, GET /api/orders/:n is confirmed, GET /api/cart is empty, stock_after = stock_before − qty per variant, and the order total is the cart total at submit', async () => {
    await fc.assert(
      fc.asyncProperty(arbLines, async (lines) => {
        const seeded = await Promise.all(
          lines.map((l) => seedVariant(k, l.qty + l.spare, { priceMinor: l.priceMinor })),
        )
        const shop = await shopperWith(
          seeded.map((s, i) => ({ variantId: s.variantId, qty: lines[i]!.qty })),
        )
        const atSubmit = (await shop.call<Cart>('GET', '/api/cart')).body.data!
        const before = await Promise.all(seeded.map((s) => stockOf(raw, s.variantId)))

        const res = await submit(shop, `ac1-${randomUUID()}@checkout.test`)

        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const answer = res.body.data!
        expect(answer.payment?.status).toBe('succeeded')
        expect(answer.orderStatus).toBe('confirmed')
        expect(answer.totalMinor).toBe(atSubmit.subtotalMinor)
        expect(answer.totalMinor).toBe(lines.reduce((sum, l) => sum + l.priceMinor * l.qty, 0))
        expect(await orderStatus(raw, answer.orderId)).toBe('confirmed')
        await vi.waitFor(
          async () => {
            const read = await shop.call<{ status: string }>(
              'GET',
              `/api/orders/${answer.orderNumber}`,
              undefined,
              { headers: { 'x-nymbal-order-key': answer.orderKey } },
            )
            expect(read.body.data?.status).toBe('confirmed')
          },
          { timeout: 5_000, interval: 25 },
        )
        const after = await shop.call<Cart>('GET', '/api/cart')
        expect(after.body.data?.items ?? []).toHaveLength(0)
        const stocks = await Promise.all(seeded.map((s) => stockOf(raw, s.variantId)))
        expect(stocks).toEqual(before.map((b, i) => b - lines[i]!.qty))
      }),
      { numRuns: 8 },
    )
  }, 120_000)

  // Kills: a declined payment read as succeeded, a decline that keeps the reserved stock, and a cart consumed by a
  // failed attempt so the shopper cannot try again.
  it('AC-4: +stub-decline answers failed and cancelled, gives the reserved stock back, records payment.failed, and a resubmit from the same cart is a fresh attempt that pays', async () => {
    const qty = 2
    const seeded = await seedVariant(k, 5)
    const shop = await shopperWith([{ variantId: seeded.variantId, qty }])
    const before = await stockOf(raw, seeded.variantId)

    const declined = await submit(shop, `ac4-${randomUUID()}+stub-decline@checkout.test`)

    expect(declined.status, JSON.stringify(declined.body)).toBe(200)
    const failed = declined.body.data!
    expect(failed.payment?.status).toBe('failed')
    expect(failed.orderStatus).toBe('cancelled')
    expect(await orderStatus(raw, failed.orderId)).toBe('cancelled')
    expect(await reservationsFor(raw, failed.orderId)).toBe(0)
    expect(await stockOf(raw, seeded.variantId)).toBe(before)
    expect(await failedFor(raw, { orderId: failed.orderId })).toHaveLength(1)
    expect(await paidFor(raw, failed.orderId)).toEqual([])
    const cart = await shop.call<Cart>('GET', '/api/cart')
    expect(cart.body.data?.items.map((i) => i.qty)).toEqual([qty])

    const retried = await submit(shop, `ac4-retry-${randomUUID()}@checkout.test`)

    expect(retried.status, JSON.stringify(retried.body)).toBe(200)
    expect(retried.body.data!.orderId).not.toBe(failed.orderId)
    expect(retried.body.data!.payment?.status).toBe('succeeded')
    expect(await orderStatus(raw, retried.body.data!.orderId)).toBe('confirmed')
    expect(await stockOf(raw, seeded.variantId)).toBe(before - qty)
  })

  // Kills: an adapter `succeeded` taken at its word: the order confirmed (or reported succeeded) although the units it
  // reserved went to another order while the shopper paid. Diff-review finding M2 also kills: the captured payment left
  // on a pending order, neither attached nor refunded, and the draft left pending with what it reserved.
  it('AC-4: (M2) an adapter that answers succeeded after another order took the reserved stock gives payment failed with stock_unavailable, refunds that intent once through the adapter, and cancels the order with its reservations released', async () => {
    const qty = 2
    const seeded = await seedVariant(k, qty)
    let other: Awaited<ReturnType<typeof checkoutOf>> | undefined
    let created: string | undefined
    const refunded: string[] = []
    const stub = k.app.adapters.payments
    const payments: PaymentsAdapter = {
      ...stub,
      // The intent is this test's own, not the stub's, so the provider answer is the test's too.
      async refund(paymentId, amountMinor, reason, opts) {
        refunded.push(paymentId)
        return {
          refundId: `re_ac4_${randomUUID()}`,
          paymentId,
          amountMinor: amountMinor ?? 0,
          currency: opts?.currency ?? k.config.store.currency,
          reason: reason ?? null,
          status: 'succeeded',
        }
      },
      async createPaymentIntent(params) {
        // The reservation lapses while the shopper pays, and another shopper takes every unit it gave back.
        const held = await k.store.read((tx) =>
          k.repos.inventoryReservation.findByVariant(tx, seeded.variantId),
        )
        for (const r of held.filter((h) => h.orderRef === params.orderRef)) {
          await k.services.inventory.releaseReservation(r.reservationId, 'expired')
        }
        other = await checkoutOf(k, seeded, qty)
        created = `pi_ac4_${randomUUID()}`
        return {
          id: created,
          clientSecret: `pi_ac4_secret_${randomUUID()}`,
          amountMinor: params.amountMinor,
          currency: params.currency,
          status: 'succeeded',
        }
      },
    }
    const checkout = createCheckoutService({
      store: k.store,
      repos: k.repos,
      publisher: k.publisher,
      logger: k.logger,
      cart: k.services.cart,
      orders: k.services.order,
      inventory: k.services.inventory,
      payments,
      currency: k.config.store.currency,
    })
    const cartToken = await cartWith(k, seeded, qty)

    const result = await checkout.beginCheckout({
      cartToken,
      email: `ac4-unit-${randomUUID()}@checkout.test`,
      billingAddress: address,
      shippingAddress: address,
    })

    expect(result.payment?.status).toBe('failed')
    expect(String(result.payment?.reason)).toMatch(/^stock_unavailable/)
    expect(result.orderStatus).not.toBe('confirmed')
    expect(await orderStatus(raw, result.orderId)).not.toBe('confirmed')
    expect(await paidFor(raw, result.orderId)).toEqual([])
    // M2: the captured money goes back, once, for the intent this checkout made; the draft does not stay pending.
    expect(created).toBeDefined()
    expect(result.paymentIntent.id).toBe(created)
    expect(refunded).toEqual([result.paymentIntent.id])
    expect(result.orderStatus).toBe('cancelled')
    expect(await orderStatus(raw, result.orderId)).toBe('cancelled')
    expect(await reservationsFor(raw, result.orderId)).toBe(0)
    // The other order keeps what it took: nothing went below zero.
    expect(other).toBeDefined()
    expect(await reservationsFor(raw, other!.orderId)).toBe(1)
    expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
  })
})
