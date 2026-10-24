import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PaymentError, type PaymentsAdapter, type Refund } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import {
  adminClient,
  storedMoney,
  storedRefunds,
  sumOf,
  type AdminClient,
  type AdminOrder,
  type RefundCall,
  type StoredMoney,
} from '../support/money.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'
import {
  deliverCapture,
  failedFor,
  historyNotes,
  processedCount,
  reservationsFor,
} from '../support/webhooks.js'

// Mark-paid and the cancelled-order backstop on SQLite: a kernel from `src/` served over HTTP, the stub payments
// adapter (its `cancelPaymentIntent` and `refund` wrapped where a test needs the provider to answer otherwise, every
// call recorded), and the committed rows read through a second connection.
//
// Mark-paid closes the order's provider intent, so a later provider capture is recorded and refunded rather than
// charging the shopper twice. Finalize's backstop refund for a cancelled order is recorded before the provider call,
// so an unknown outcome never leaves money moved and unrecorded.

type RefundImpl = NonNullable<PaymentsAdapter['refund']>

const DUPLICATE = 'duplicate_capture_refunded'

describe('mark-paid, duplicate captures and the backstop refund (sqlite)', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader
  let admin: AdminClient
  let payments: PaymentsAdapter
  let stubRefund: RefundImpl
  let stubCancel: PaymentsAdapter['cancelPaymentIntent']
  /** Every refund the shop asked the provider for, in order, since the last `provider()`. */
  let calls: RefundCall[] = []

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
    admin = await adminClient(k, served.baseUrl)
    payments = k.app.adapters.payments
    stubRefund = payments.refund.bind(payments)
    stubCancel = payments.cancelPaymentIntent.bind(payments)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  /** The provider's refund answered by `impl` (the stub's by default), every call recorded. */
  function provider(impl: RefundImpl = stubRefund): void {
    calls = []
    payments.refund = async (paymentId, amountMinor, reason, opts) => {
      calls.push([paymentId, amountMinor, reason, opts])
      return impl(paymentId, amountMinor, reason, opts)
    }
  }

  function restoreProvider(): void {
    payments.refund = stubRefund
    payments.cancelPaymentIntent = stubCancel
  }

  /** A provider answer that refunds exactly what was asked, in the order's currency. */
  const succeeds =
    (currency: string): RefundImpl =>
    async (paymentId, amountMinor) =>
      ({
        refundId: `re_review_${randomUUID()}`,
        paymentId,
        amountMinor: amountMinor ?? 0,
        currency,
        reason: 'requested_by_customer',
        status: 'succeeded',
      }) satisfies Refund

  /** A `+stub-pending` checkout: a pending order with an intent and nothing captured. */
  async function pendingOrder(priceMinor = 1_800, qty = 1) {
    const seeded = await seedVariant(k, qty + 3, { priceMinor })
    const started = await checkoutOf(k, seeded, qty)
    expect(started.orderStatus).toBe('pending')
    return { ...started, seeded }
  }

  function markPaid(orderId: string) {
    return admin.call<AdminOrder>('POST', `/api/admin/orders/${orderId}/mark-paid`, {})
  }

  const keysOf = (recorded: RefundCall[]) => new Set(recorded.map((c) => c[3]?.idempotencyKey))

  describe('B1 prevention: mark-paid cancels the provider intent first', () => {
    // Kills: mark-paid confirming with the order's intent still payable, so the shopper can complete it and pay twice.
    it('B1: mark-paid on a +stub-pending order calls payments.cancelPaymentIntent once with the order’s intent while nothing is captured yet, then records the manual capture of the total', async () => {
      const order = await pendingOrder(2_300, 2)
      const cancels: Array<{ intentId: string; then: StoredMoney }> = []
      payments.cancelPaymentIntent = async (intentId) => {
        cancels.push({ intentId, then: await storedMoney(raw, order.orderId) })
        return stubCancel(intentId)
      }
      let res: Awaited<ReturnType<typeof markPaid>>
      try {
        res = await markPaid(order.orderId)
      } finally {
        restoreProvider()
      }

      expect(cancels.map((c) => c.intentId)).toEqual([order.paymentIntent.id])
      // Before the capture is recorded: the cancel saw the order pending with nothing captured.
      expect(cancels[0]!.then.status).toBe('pending')
      expect(cancels[0]!.then.capturedMinor).toBe(0)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.status).toBe('confirmed')
      expect(stored.capturedMinor).toBe(stored.totalMinor)
      expect(stored.captureMethod).toBe('manual')
    })

    // Kills: mark-paid confirming an order whose provider payment is under way (two captures of one order).
    it('B1: when the provider refuses the cancel (cancel_refused: the payment is under way), mark-paid answers 409 order.payment_in_progress and changes nothing: status, amounts, refunds, stock, reservations, history and events are as they were', async () => {
      const order = await pendingOrder(1_450, 2)
      const before = {
        money: await storedMoney(raw, order.orderId),
        refunds: await storedRefunds(raw, order.orderId),
        stock: await stockOf(raw, order.seeded.variantId),
        reservations: await reservationsFor(raw, order.orderId),
        history: await historyNotes(raw, order.orderId),
        events: await raw.count('events'),
      }
      const cancels: string[] = []
      payments.cancelPaymentIntent = async (intentId) => {
        cancels.push(intentId)
        throw new PaymentError('cancel_refused', `intent ${intentId} is processing`)
      }
      let res: Awaited<ReturnType<typeof markPaid>>
      try {
        res = await markPaid(order.orderId)
      } finally {
        restoreProvider()
      }

      expect(cancels).toEqual([order.paymentIntent.id])
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error?.code).toBe('order.payment_in_progress')
      const after = {
        money: await storedMoney(raw, order.orderId),
        refunds: await storedRefunds(raw, order.orderId),
        stock: await stockOf(raw, order.seeded.variantId),
        reservations: await reservationsFor(raw, order.orderId),
        history: await historyNotes(raw, order.orderId),
        events: await raw.count('events'),
      }
      expect(after).toEqual(before)
    })
  })

  describe('B1 backstop: a provider capture of an order already captured outside the provider is refunded', () => {
    // Kills: `settled` treating any confirmed order as done, so a second capture of a manually paid order is kept
    // unrecorded (the shopper charged twice); and a redelivery refunding it again.
    it('B1: a stub payment.captured for an order mark-paid already captured is refunded in full once (intent, total, one idempotency key across a redelivery and a second finalize), recorded as a history note and payment.failed duplicate_capture_refunded; captured, refunded, refund rows and status are unchanged', async () => {
      const order = await pendingOrder(2_600, 1)
      expect((await markPaid(order.orderId)).status).toBe(200)
      const before = {
        money: await storedMoney(raw, order.orderId),
        refunds: await storedRefunds(raw, order.orderId),
      }
      const eventId = `evt_${randomUUID()}`

      provider(succeeds(order.currency))
      try {
        await deliverCapture(served.baseUrl, order, { eventId })
        // The provider's redelivery of the same event, and the same capture reaching finalize again.
        await deliverCapture(served.baseUrl, order, { eventId })
        await k.services.checkout.finalize(order.paymentIntent.id, {
          amountMinor: order.totalMinor,
          currency: order.currency,
        })
      } finally {
        restoreProvider()
      }

      expect(keysOf(calls).size, JSON.stringify(calls)).toBe(1)
      for (const [paymentId, amountMinor] of calls) {
        expect(paymentId).toBe(order.paymentIntent.id)
        expect(amountMinor).toBe(before.money.capturedMinor)
      }
      expect(await storedMoney(raw, order.orderId)).toEqual(before.money)
      expect(await storedRefunds(raw, order.orderId)).toEqual(before.refunds)
      const failed = await failedFor(raw, { orderId: order.orderId })
      expect(failed.filter((f) => f.reason === DUPLICATE)).toHaveLength(1)
      expect(
        (await historyNotes(raw, order.orderId)).filter((n) => n.includes(DUPLICATE)),
      ).toHaveLength(1)
    })

    // Kills: a provider capture of an imported (already paid) order kept, or counted into captured_minor.
    it('B1: a provider capture reaching finalize for an imported order (captureMethod import) is refunded in full once through payments.refund, recorded as payment.failed duplicate_capture_refunded; captured, refunded, refund rows and status are unchanged', async () => {
      const orderId = uuidv7()
      const paymentIntentId = `pi_import_${randomUUID()}`
      const totalMinor = 5_180
      await k.services.order.importOrder({
        orderId,
        orderNumber: `WC-${randomUUID().slice(0, 8)}`,
        status: 'delivered',
        createdAt: new Date('2025-06-01T10:00:00Z'),
        customerId: null,
        email: `imported-${randomUUID()}@money.test`,
        billingAddress: address,
        shippingAddress: address,
        lineItems: [],
        subtotalMinor: totalMinor,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor,
        currency: 'GBP',
        paymentIntentId,
        capturedMinor: totalMinor,
        refundedMinor: 0,
        captureMethod: 'import',
      })
      const before = {
        money: await storedMoney(raw, orderId),
        refunds: await storedRefunds(raw, orderId),
      }

      provider(succeeds('GBP'))
      try {
        for (let i = 0; i < 2; i += 1) {
          await k.services.checkout.finalize(paymentIntentId, {
            amountMinor: totalMinor,
            currency: 'GBP',
          })
        }
      } finally {
        restoreProvider()
      }

      expect(keysOf(calls).size, JSON.stringify(calls)).toBe(1)
      for (const [paymentId, amountMinor] of calls) {
        expect(paymentId).toBe(paymentIntentId)
        expect(amountMinor).toBe(before.money.capturedMinor)
      }
      expect(await storedMoney(raw, orderId)).toEqual(before.money)
      expect(await storedRefunds(raw, orderId)).toEqual(before.refunds)
      const failed = await failedFor(raw, { orderId })
      expect(failed.some((f) => f.reason === DUPLICATE)).toBe(true)
      expect((await historyNotes(raw, orderId)).some((n) => n.includes(DUPLICATE))).toBe(true)
    })
  })

  describe("M3: finalize's backstop refund for a cancelled order is recorded before the provider call", () => {
    /** A cancelled +stub-pending order whose capture is delivered, then redelivered, the provider failing as `fail`. */
    async function backstop(fail: () => never) {
      const order = await pendingOrder(3_100, 1)
      await k.services.checkout.cancel(order.orderId, 'customer changed their mind')
      const eventId = `evt_${randomUUID()}`
      provider(async () => fail())
      try {
        await deliverCapture(served.baseUrl, order, { eventId })
        await deliverCapture(served.baseUrl, order, { eventId })
        // The same capture under another event id: still never a second refund row.
        await deliverCapture(served.baseUrl, order)
      } finally {
        restoreProvider()
      }
      return { order, eventId }
    }

    // Kills: the refund row and capture written only after the provider answers, so a timeout rolls the delivery back
    // and the redelivery's new key meets a charge already refunded: money moved and never recorded.
    it('M3: refund_unknown (a timeout) leaves the capture recorded and one pending refund row whose id is every provider call’s idempotency key; the delivery is recorded once and a redelivery makes no second row', async () => {
      const { order, eventId } = await backstop(() => {
        throw new PaymentError('refund_unknown', 'Stripe timed out')
      })

      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => [r.status, r.amountMinor])).toEqual([['pending', order.totalMinor]])
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect([...keysOf(calls)]).toEqual([rows[0]!.id])
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.status).toBe('cancelled')
      expect(stored.capturedMinor).toBe(order.totalMinor)
      expect(stored.refundedMinor).toBe(sumOf(rows, 'succeeded'))
      expect(await processedCount(raw, eventId)).toBe(1)
    })

    // Kills: a definite refusal rolling the delivery back with nothing recorded.
    it('M3: refund_rejected leaves the capture recorded and one failed refund row keyed by its id; refundedMinor stays 0; the delivery is recorded once and a redelivery makes no second row', async () => {
      const { order, eventId } = await backstop(() => {
        throw new PaymentError('refund_rejected', 'card refused the refund')
      })

      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => [r.status, r.amountMinor])).toEqual([['failed', order.totalMinor]])
      expect([...keysOf(calls)]).toEqual([rows[0]!.id])
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.status).toBe('cancelled')
      expect(stored.capturedMinor).toBe(order.totalMinor)
      expect(stored.refundedMinor).toBe(sumOf(rows, 'succeeded'))
      expect(await processedCount(raw, eventId)).toBe(1)
    })
  })
})
