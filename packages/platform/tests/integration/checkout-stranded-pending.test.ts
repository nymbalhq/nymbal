import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart, PaymentStatus, PaymentsAdapter } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import { orderStatus, reservationsFor } from '../support/webhooks.js'

// AC-3 on SQLite over HTTP. A pending order that never got its intent does not hold its cart at 409
// checkout.in_progress for good: older than 120 s it is abandoned and the checkout places a new order; younger, it is
// still a checkout in flight. The stranded order is made the way a crash leaves it: a real order whose intent column
// is cleared and whose created_at is moved back, on a second connection (no clock in the service, no sleep).
// A resubmit of an unchanged cart answers its pending order by what the provider says of the intent now, never
// `succeeded`.

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  paymentIntent: { id: string; status: string }
  orderStatus: string
  payment: { status: 'succeeded' | 'requires_action' | 'failed'; reason?: string }
}

interface ErrorAnswer {
  code: string
}

type Shop = Awaited<ReturnType<typeof primedShopper>>

const pending = (tag: string) => `ac3-${tag}-${randomUUID()}+stub-pending@checkout.test`
const paying = (tag: string) => `ac3-${tag}-${randomUUID()}@checkout.test`

const ABANDON_AFTER_MS = 120_000

describe('AC-3: review round, a pending order that can no longer be paid (sqlite)', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader
  let payments: PaymentsAdapter

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
    payments = k.app.adapters.payments
  }, 60_000)

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
    const token = shop.jar.get('nymbal.cart')
    if (token === undefined) throw new Error('the store set no nymbal.cart cookie')
    return { shop, token }
  }

  function submit(shop: Shop, email: string) {
    return shop.call<CheckoutAnswer>('POST', '/api/checkout', {
      email,
      billingAddress: address,
      shippingAddress: address,
    })
  }

  async function ordersOf(token: string) {
    return raw.rows<{ id: string; status: string; payment_intent_id: string | null }>(
      'SELECT id, status, payment_intent_id FROM orders WHERE cart_token = ? ORDER BY sequence',
      [token],
    )
  }

  async function reservedQty(variantId: string): Promise<number> {
    const rows = await raw.rows<{ qty: number }>(
      'SELECT qty FROM inventory_reservations WHERE variant_id = ?',
      [variantId],
    )
    return rows.reduce((sum, r) => sum + Number(r.qty), 0)
  }

  /**
   * Leaves order `orderId` as a crash between T1 and T2 would: pending, its reservations held, no intent, created
   * `ageMs` ago. Written on a second connection in the column's own format.
   */
  async function strand(orderId: string, ageMs: number): Promise<void> {
    const db = new Database(k.target)
    db.pragma('busy_timeout = 5000')
    try {
      const row = db.prepare('SELECT created_at FROM orders WHERE id = ?').get(orderId) as {
        created_at: string | number
      }
      const at = Date.now() - ageMs
      const value = typeof row.created_at === 'number' ? at : new Date(at).toISOString()
      db.prepare(
        'UPDATE orders SET payment_intent_id = NULL, created_at = ?, updated_at = ? WHERE id = ?',
      ).run(value, value, orderId)
    } finally {
      db.close()
    }
  }

  // Finding B1. Kills: a null-intent pending order treated as in flight whatever its age, so the cart answers 409
  // checkout.in_progress for good; or an abandoned order replaced without releasing what it reserved; or a threshold
  // so short that a checkout still creating its intent is overtaken.
  it('AC-3: (B1) a pending order with no intent answers 409 checkout.in_progress while younger than 120 s; older than 120 s it is cancelled with its reservations released and the resubmit places a new order', async () => {
    const qty = 2
    const seeded = await seedVariant(k, 6)
    const { shop, token } = await shopWith(seeded, qty)
    const first = await submit(shop, pending('stranded'))
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const stranded = first.body.data!.orderId

    await strand(stranded, ABANDON_AFTER_MS - 10_000)
    const young = await submit(shop, paying('stranded-young'))

    expect(young.status, JSON.stringify(young.body)).toBe(409)
    expect((young.body.error as ErrorAnswer | undefined)?.code).toBe('checkout.in_progress')
    expect((await ordersOf(token)).map((o) => [o.id, o.status])).toEqual([[stranded, 'pending']])
    expect(await reservationsFor(raw, stranded)).toBe(1)
    expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)

    await strand(stranded, ABANDON_AFTER_MS + 5_000)
    const old = await submit(shop, paying('stranded-old'))

    expect(old.status, JSON.stringify(old.body)).toBe(200)
    const fresh = old.body.data!
    expect(fresh.orderId).not.toBe(stranded)
    expect(fresh.payment.status).toBe('succeeded')
    expect(await orderStatus(raw, stranded)).toBe('cancelled')
    expect(await reservationsFor(raw, stranded)).toBe(0)
    expect(Object.fromEntries((await ordersOf(token)).map((o) => [o.id, o.status]))).toEqual({
      [stranded]: 'cancelled',
      [fresh.orderId]: 'confirmed',
    })
    // One decrement for the one paid order: the abandoned order's units came back before the new order took its own.
    expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
  })

  // Finding M3. Kills: answerExisting answering requires_action whatever the provider says, so an intent the provider
  // cancelled or failed strands the cart until it changes; a fresh attempt that keeps the dead order's reservations;
  // and an existing-order answer of `succeeded` for an order that is not confirmed.
  it('AC-3: (M3) over every provider status of a pending order intent, a resubmit of the unchanged cart cancels the order and answers a fresh order with a new intent when the intent is cancelled or failed, else answers the same order and intent, never succeeded', async () => {
    const statuses: PaymentStatus[] = [
      'requires_payment_method',
      'requires_confirmation',
      'requires_action',
      'processing',
      'requires_capture',
      'succeeded',
      'cancelled',
      'failed',
    ]
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...statuses), async (now) => {
        const qty = 1
        const seeded = await seedVariant(k, 4)
        const { shop, token } = await shopWith(seeded, qty)
        const first = await submit(shop, pending('provider-now'))
        expect(first.status, JSON.stringify(first.body)).toBe(200)
        const before = first.body.data!

        const original = payments.getPaymentIntent
        payments.getPaymentIntent = async (intentId) => {
          const intent = await original.call(payments, intentId)
          return intentId === before.paymentIntent.id ? { ...intent, status: now } : intent
        }
        let again: Awaited<ReturnType<typeof submit>>
        try {
          again = await submit(shop, pending('provider-now'))
        } finally {
          payments.getPaymentIntent = original
        }

        expect(again.status, `${now}: ${JSON.stringify(again.body)}`).toBe(200)
        const answer = again.body.data!
        const dead = now === 'cancelled' || now === 'failed'
        const orders = await ordersOf(token)
        expect(
          {
            freshOrder: answer.orderId !== before.orderId,
            freshIntent: answer.paymentIntent.id !== before.paymentIntent.id,
            orders: Object.fromEntries(orders.map((o) => [o.id, o.status])),
            heldByFirst: await reservationsFor(raw, before.orderId),
          },
          now,
        ).toEqual({
          freshOrder: dead,
          freshIntent: dead,
          orders: dead
            ? { [before.orderId]: 'cancelled', [answer.orderId]: 'pending' }
            : { [before.orderId]: 'pending' },
          heldByFirst: dead ? 0 : 1,
        })
        // A pending order (the same one, or the fresh +stub-pending one) is answered requires_action: the existing-order
        // answer is never succeeded, even when the provider has captured and the webhook has not confirmed yet.
        expect(answer.payment.status, now).toBe('requires_action')
        // Either way one order holds the cart's units: reserved = qty and stock + reserved is the stock at the start.
        expect(await reservedQty(seeded.variantId), now).toBe(qty)
        expect((await stockOf(raw, seeded.variantId)) + qty, now).toBe(seeded.initialStock)
      }),
      { numRuns: 16 },
    )
  }, 120_000)

  // Finding M3, end to end through the stub: the provider's own cancel, not an overridden read.
  it('AC-3: (M3) after the provider cancels the pending order intent, a resubmit of the unchanged cart answers a fresh order with a new intent and the cancelled order releases its stock', async () => {
    const qty = 2
    const seeded = await seedVariant(k, 5)
    const { shop, token } = await shopWith(seeded, qty)
    const first = await submit(shop, pending('provider-cancel'))
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const before = first.body.data!
    const open = await submit(shop, pending('provider-cancel'))
    expect(open.body.data?.orderId).toBe(before.orderId)
    expect(open.body.data?.payment.status).toBe('requires_action')

    await payments.cancelPaymentIntent(before.paymentIntent.id)
    const again = await submit(shop, pending('provider-cancel'))

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data!.orderId).not.toBe(before.orderId)
    expect(again.body.data!.paymentIntent.id).not.toBe(before.paymentIntent.id)
    expect(await orderStatus(raw, before.orderId)).toBe('cancelled')
    expect((await ordersOf(token)).filter((o) => o.status === 'pending')).toHaveLength(1)
    expect(await reservedQty(seeded.variantId)).toBe(qty)
    expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
  })
})
