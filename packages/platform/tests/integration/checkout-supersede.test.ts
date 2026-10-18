import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PaymentError, type Cart, type PaymentIntentParams } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import {
  deliverCapture,
  failedFor,
  historyNotes,
  orderStatus,
  paidFor,
  reservationsFor,
} from '../support/webhooks.js'

// P1-12 AC-12 (decision 11) on SQLite over HTTP, with a fake payments adapter in the kernel's place: every intent
// needs confirming (as Stripe's do), and the test decides whether a cancel is refused. Superseding a changed cart's
// pending order cancels its intent first; a refused cancel answers 409 checkout.payment_in_progress and changes
// nothing; a capture that arrives for a cancelled order is refunded in full through the adapter and recorded. Never
// money without an order.

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  paymentIntent: { id: string }
  currency: string
  totalMinor: number
}

interface ErrorAnswer {
  code: string
  context?: { orderNumber?: string }
}

describe('P1-12 AC-12: superseding never strands money (sqlite)', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader
  /** What the shop asked the provider, in order: `create:<intent>`, `cancel:<intent>`, `refund:<intent>:<amount>`. */
  let log: string[]
  let refuseCancel: boolean

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
    // The checkout service and the webhook route look the adapter's methods up at call time.
    const payments = k.app.adapters.payments
    const create = payments.createPaymentIntent.bind(payments)
    const refund = payments.refund.bind(payments)
    payments.createPaymentIntent = async (params: PaymentIntentParams) => {
      const intent = await create(params)
      log.push(`create:${intent.id}`)
      return { ...intent, status: 'requires_payment_method' }
    }
    payments.cancelPaymentIntent = async (intentId: string) => {
      if (refuseCancel) {
        log.push(`cancel-refused:${intentId}`)
        throw new PaymentError('cancel_refused', `intent ${intentId} is processing`)
      }
      log.push(`cancel:${intentId}`)
    }
    payments.refund = async (paymentId, amountMinor, reason) => {
      log.push(`refund:${paymentId}:${amountMinor ?? 'full'}`)
      return refund(paymentId, amountMinor, reason)
    }
  }, 60_000)

  beforeEach(() => {
    log = []
    refuseCancel = false
  })

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  async function shopWith(seeded: Seeded, qty: number) {
    const shop = await primedShopper(served.baseUrl)
    expect((await shop.call<Cart>('GET', '/api/cart')).status).toBe(200)
    const added = await shop.call<Cart>('POST', '/api/cart/items', {
      variantId: seeded.variantId,
      qty,
    })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    return shop
  }

  function submit(shop: Awaited<ReturnType<typeof shopWith>>) {
    return shop.call<CheckoutAnswer>('POST', '/api/checkout', {
      email: `ac12-${randomUUID()}@p1-12.test`,
      billingAddress: address,
      shippingAddress: address,
    })
  }

  // Kills: a supersede that cancels the old order but leaves its intent payable, so the shopper can still be charged
  // for an order that no longer exists.
  it('AC-12: a changed cart cancels the old intent with the provider before the new order is created; the old order is cancelled and its reservations released', async () => {
    const a = await seedVariant(k, 5)
    const b = await seedVariant(k, 5)
    const shop = await shopWith(a, 1)
    const first = await submit(shop)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const old = first.body.data!
    await shop.call('POST', '/api/cart/items', { variantId: b.variantId, qty: 1 })

    const second = await submit(shop)

    expect(second.status, JSON.stringify(second.body)).toBe(200)
    const fresh = second.body.data!
    const cancelledAt = log.indexOf(`cancel:${old.paymentIntent.id}`)
    const createdAt = log.indexOf(`create:${fresh.paymentIntent.id}`)
    expect(cancelledAt, log.join(' ')).toBeGreaterThanOrEqual(0)
    expect(cancelledAt, log.join(' ')).toBeLessThan(createdAt)
    expect(await orderStatus(raw, old.orderId)).toBe('cancelled')
    expect(await reservationsFor(raw, old.orderId)).toBe(0)
    expect(await orderStatus(raw, fresh.orderId)).toBe('pending')
    expect(await stockOf(raw, a.variantId)).toBe(a.initialStock - 1)
  })

  // Kills: a supersede that goes ahead when the provider will not cancel (the shopper is mid-payment), cancelling the
  // order their money is about to land on.
  it('AC-12: a refused cancel answers 409 checkout.payment_in_progress naming the old order and changes nothing: orders, statuses, stock, reservations and the event log are as before', async () => {
    const a = await seedVariant(k, 5)
    const b = await seedVariant(k, 5)
    const shop = await shopWith(a, 2)
    const first = await submit(shop)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const old = first.body.data!
    await shop.call('POST', '/api/cart/items', { variantId: b.variantId, qty: 1 })
    refuseCancel = true
    const snapshot = async () => ({
      orders: await raw.rows<{ id: string; status: string }>(
        'SELECT id, status FROM orders ORDER BY id',
      ),
      stock: [await stockOf(raw, a.variantId), await stockOf(raw, b.variantId)],
      reservations: await raw.count('inventory_reservations'),
      events: (await eventRows(raw)).length,
    })
    const before = await snapshot()
    const logBefore = log.length

    const second = await submit(shop)

    expect(second.status, JSON.stringify(second.body)).toBe(409)
    const error = second.body.error as ErrorAnswer | undefined
    expect(error?.code).toBe('checkout.payment_in_progress')
    expect(error?.context?.orderNumber).toBe(old.orderNumber)
    expect(await snapshot()).toEqual(before)
    const createdSince = log.slice(logBefore).filter((entry) => entry.startsWith('create:'))
    expect(createdSince, log.join(' ')).toEqual([])
  })

  // Kills: the backstop missing: a capture for a cancelled order is recorded as not applied and the money is kept.
  it('AC-12: a capture arriving for a cancelled order is refunded in full through the adapter, recorded as payment.failed order_cancelled_refunded with a history note; the order stays cancelled and is never paid', async () => {
    const a = await seedVariant(k, 5)
    const shop = await shopWith(a, 1)
    const first = await submit(shop)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const order = first.body.data!
    await k.services.checkout.cancel(order.orderId, 'superseded')

    const answer = await deliverCapture(served.baseUrl, order)

    expect(answer.status, JSON.stringify(answer)).toBe(200)
    const refunds = log.filter((entry) => entry.startsWith(`refund:${order.paymentIntent.id}:`))
    expect(refunds.length, log.join(' ')).toBe(1)
    expect([
      `refund:${order.paymentIntent.id}:full`,
      `refund:${order.paymentIntent.id}:${order.totalMinor}`,
    ]).toContain(refunds[0])
    const failed = await failedFor(raw, { orderId: order.orderId })
    expect(failed.map((f) => f.reason)).toEqual(['order_cancelled_refunded'])
    expect(
      (await historyNotes(raw, order.orderId)).filter((n) =>
        n.includes('order_cancelled_refunded'),
      ),
    ).toHaveLength(1)
    expect(await orderStatus(raw, order.orderId)).toBe('cancelled')
    expect(await paidFor(raw, order.orderId)).toEqual([])
  })
})
