import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PaymentError,
  type PaymentIntent,
  type PaymentsAdapter,
  type Refund,
} from '@nymbalhq/types'
import { startInventoryReservationSweeper } from '../../src/sweepers/inventory-reservation-sweeper.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import {
  address,
  cartWith,
  checkoutOf,
  createKernel,
  seedVariant,
  type Kernel,
} from '../support/kernel.js'
import {
  adminClient,
  adminOrder,
  storedMoney,
  storedRefunds,
  sumOf,
  type AdminClient,
  type AdminOrder,
  type RefundCall,
} from '../support/money.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'
import {
  deliverCapture,
  eventsOfType,
  expiredCheckout,
  historyNotes,
  orderStatus,
  paidFor,
} from '../support/webhooks.js'

// P1-13 AC-2, AC-3, AC-4, AC-6 and AC-13 on SQLite: a kernel from `src/` served over HTTP, the admin's own routes, the
// stub payments adapter (wrapped where a test needs the provider to answer otherwise), and the committed rows read
// through a second connection. The adapter is the kernel's own object (`k.app.adapters.payments`): a test that changes
// what the provider answers replaces its `refund` (or `createPaymentIntent`) for the test's duration.

type RefundImpl = NonNullable<PaymentsAdapter['refund']>

const PaymentErrorCode = (code: string) => code as ConstructorParameters<typeof PaymentError>[0]

describe('P1-13: the admin tells the truth about money (sqlite)', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader
  let admin: AdminClient
  let payments: PaymentsAdapter
  let stubRefund: RefundImpl
  let stubCreate: PaymentsAdapter['createPaymentIntent']
  /** Every refund the shop asked the provider for, in order, since the last `resetCalls`. */
  let calls: RefundCall[] = []

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
    admin = await adminClient(k, served.baseUrl)
    payments = k.app.adapters.payments
    stubRefund = payments.refund.bind(payments)
    stubCreate = payments.createPaymentIntent.bind(payments)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  /** The provider's refund answered by `impl` (the stub's by default), every call recorded. */
  function provider(impl: RefundImpl = stubRefund): void {
    calls = []
    const recorded = async (
      paymentId: string,
      amountMinor?: number,
      reason?: string,
      opts?: { idempotencyKey?: string },
    ): Promise<Refund> => {
      calls.push([paymentId, amountMinor, reason, opts])
      return (impl as (...a: unknown[]) => Promise<Refund>)(paymentId, amountMinor, reason, opts)
    }
    payments.refund = recorded
  }

  function restoreProvider(): void {
    payments.refund = stubRefund
    payments.createPaymentIntent = stubCreate
  }

  /** A checkout the stub pays inline: a confirmed order whose capture is its total. */
  async function paidOrder(priceMinor = 2_500, qty = 2) {
    const seeded = await seedVariant(k, qty + 3, { priceMinor })
    const started = await checkoutOf(k, seeded, qty, `paid-${randomUUID()}@p1-13.test`)
    if (started.orderStatus !== 'confirmed') {
      throw new Error(`stub checkout did not confirm: ${JSON.stringify(started.payment)}`)
    }
    return { ...started, seeded }
  }

  /** A `+stub-pending` checkout: a pending order with an intent and nothing captured. */
  async function pendingOrder(priceMinor = 1_800, qty = 1) {
    const seeded = await seedVariant(k, qty + 3, { priceMinor })
    const started = await checkoutOf(k, seeded, qty)
    return { ...started, seeded }
  }

  function refund(orderId: string, amountMinor: number, reason?: string) {
    return admin.call<{
      order: AdminOrder
      payment: AdminOrder['payment']
      refund: { id: string }
    }>(
      'POST',
      `/api/admin/orders/${orderId}/refund`,
      reason === undefined ? { amountMinor } : { amountMinor, reason },
    )
  }

  function markPaid(orderId: string) {
    return admin.call<AdminOrder>('POST', `/api/admin/orders/${orderId}/mark-paid`, {})
  }

  describe('AC-2: captures are recorded where they happen', () => {
    // Kills: the capture not written at finalize's confirm, the wrong amount or method written, and the read still
    // deriving "paid" from something other than the stored amounts.
    it('AC-2: over generated carts, a stub checkout records capturedMinor = total, a capturedAt within the checkout and captureMethod provider; the admin detail and list read paid with captured = refundable = total', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 40_000 }),
          fc.integer({ min: 1, max: 4 }),
          async (priceMinor, qty) => {
            const before = Date.now()
            const order = await paidOrder(priceMinor, qty)
            const after = Date.now()

            const stored = await storedMoney(raw, order.orderId)
            expect(stored.capturedMinor).toBe(order.totalMinor)
            expect(stored.capturedMinor).toBe(priceMinor * qty)
            expect(stored.refundedMinor).toBe(0)
            expect(stored.captureMethod).toBe('provider')
            const capturedAt = Date.parse(String(stored.capturedAt))
            expect(capturedAt).toBeGreaterThanOrEqual(before - 1_000)
            expect(capturedAt).toBeLessThanOrEqual(after + 1_000)

            const detail = await adminOrder(admin, order.orderNumber)
            expect(detail.payment?.state).toBe('paid')
            expect(detail.payment?.capturedMinor).toBe(stored.capturedMinor)
            expect(detail.payment?.refundedMinor).toBe(0)
            expect(detail.payment?.refundableMinor).toBe(stored.capturedMinor)
            expect(detail.captureMethod).toBe('provider')

            const list = await admin.call<AdminOrder[]>(
              'GET',
              `/api/admin/orders?q=${encodeURIComponent(order.orderNumber)}`,
            )
            const row = (list.body.data ?? []).find((o) => o.orderNumber === order.orderNumber)
            expect(row?.payment).toEqual(detail.payment)
          },
        ),
        { numRuns: 6 },
      )
    }, 120_000)

    // Kills: "paid" derived from the intent every order has from checkout start.
    it('AC-2: a +stub-pending order has an intent and records nothing: capturedMinor 0, no capturedAt, no captureMethod; the admin reads unpaid with nothing refundable', async () => {
      const order = await pendingOrder()

      const stored = await storedMoney(raw, order.orderId)
      expect(order.paymentIntent.id).toMatch(/^pi_stub_/)
      expect(stored.status).toBe('pending')
      expect(stored.capturedMinor).toBe(0)
      expect(stored.refundedMinor).toBe(0)
      expect(stored.capturedAt).toBeNull()
      expect(stored.captureMethod).toBeNull()

      const detail = await adminOrder(admin, order.orderNumber)
      expect(detail.payment?.state).toBe('unpaid')
      expect(detail.payment?.capturedMinor).toBe(stored.capturedMinor)
      expect(detail.payment?.refundableMinor).toBe(0)
    })

    // Kills (B4): mark-paid publishing order.paid without confirming through finalize's confirm, so the reservation is
    // never committed and the sweeper gives the paid order's stock back (oversell); and a manual capture not recorded.
    it('AC-2: mark-paid on a +stub-pending order records a manual capture of the total, confirms it and commits its reservations: after the reservation TTL and a sweeper tick the stock is still stock_before − qty', async () => {
      const qty = 2
      const seeded = await seedVariant(k, 5, { priceMinor: 1_250 })
      const inventory = k.services.inventory
      const reserve = inventory.reserveStock
      // Reservations taken already past their TTL: the next sweeper tick releases whatever is still held.
      inventory.reserveStock = (variantId, reserveQty, orderRef) =>
        reserve.call(inventory, variantId, reserveQty, orderRef, -3600)
      let order: Awaited<ReturnType<typeof checkoutOf>>
      try {
        order = await checkoutOf(k, seeded, qty)
      } finally {
        inventory.reserveStock = reserve
      }
      const stockAfterCheckout = await stockOf(raw, seeded.variantId)
      expect(stockAfterCheckout).toBe(seeded.initialStock - qty)

      const res = await markPaid(order.orderId)

      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const sweeper = startInventoryReservationSweeper({
        inventoryService: k.services.inventory,
        reservationRepo: k.repos.inventoryReservation,
        logger: k.logger,
        intervalMs: 3_600_000,
      })
      try {
        await sweeper.tick()
      } finally {
        sweeper.stop()
      }
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.status).toBe('confirmed')
      expect(stored.capturedMinor).toBe(order.totalMinor)
      expect(stored.captureMethod).toBe('manual')
      expect(stored.capturedAt).not.toBeNull()
      expect((await adminOrder(admin, order.orderNumber)).payment?.state).toBe('paid')
      expect(
        (await historyNotes(raw, order.orderId)).some((n) => /payment recorded manually/i.test(n)),
      ).toBe(true)
      // The manual capture announces the payment once, for the order's total (decision 2).
      expect((await paidFor(raw, order.orderId)).map((p) => [p.amountMinor, p.currency])).toEqual([
        [order.totalMinor, order.currency],
      ])
    })

    // Kills: a mark-paid that confirms without re-taking stock the sweeper already gave back.
    it('AC-2: mark-paid on a +stub-pending order whose reservation was already released re-takes the stock (stock_before − qty) and records the manual capture', async () => {
      const qty = 1
      const seeded = await seedVariant(k, 4, { priceMinor: 990 })
      const order = await expiredCheckout(k, seeded, qty)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock)

      const res = await markPaid(order.orderId)

      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.status).toBe('confirmed')
      expect(stored.capturedMinor).toBe(order.totalMinor)
      expect(stored.captureMethod).toBe('manual')
    })

    // Kills: a manual capture that confirms an order whose stock another order now holds (oversell).
    it('AC-2: mark-paid whose released stock another order took answers 409 stock_unavailable and leaves the order pending with nothing captured', async () => {
      const qty = 2
      const seeded = await seedVariant(k, qty, { priceMinor: 700 })
      const order = await expiredCheckout(k, seeded, qty)
      const other = await checkoutOf(k, seeded, qty, `other-${randomUUID()}@p1-13.test`)
      expect(other.orderStatus).toBe('confirmed')

      const res = await markPaid(order.orderId)

      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error?.code).toMatch(/stock_unavailable$/)
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.status).toBe('pending')
      expect(stored.capturedMinor).toBe(0)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
    })
  })

  describe('AC-3: refund rules', () => {
    // Kills: a refund of an order nobody paid (the old label-only refund).
    it('AC-3: a refund of an uncaptured order answers 409 refund.not_captured, calls no provider, writes no refund row and changes no amount or status', async () => {
      const order = await pendingOrder()
      provider()
      try {
        const res = await refund(order.orderId, 100)

        expect(res.status, JSON.stringify(res.body)).toBe(409)
        expect(res.body.error?.code).toBe('refund.not_captured')
      } finally {
        restoreProvider()
      }
      expect(calls).toEqual([])
      const after = await storedMoney(raw, order.orderId)
      expect([after.status, after.capturedMinor, after.refundedMinor]).toEqual(['pending', 0, 0])
      expect(await raw.count('order_refunds', 'order_id = ?', [order.orderId])).toBe(0)
    })

    // Kills: an over-refund, and a zero or negative refund accepted.
    it('AC-3: refundable + 1 answers 409 refund.exceeds_captured; 0 and a negative amount answer 400 validation.failed; none calls the provider or writes a row', async () => {
      const order = await paidOrder(3_000, 1)
      const statusBefore = await orderStatus(raw, order.orderId)
      provider()
      try {
        const over = await refund(order.orderId, order.totalMinor + 1)
        expect(over.status, JSON.stringify(over.body)).toBe(409)
        expect(over.body.error?.code).toBe('refund.exceeds_captured')

        for (const amountMinor of [0, -1, -order.totalMinor]) {
          const bad = await refund(order.orderId, amountMinor)
          expect(bad.status, `${amountMinor}: ${JSON.stringify(bad.body)}`).toBe(400)
          expect(bad.body.error?.code).toBe('validation.failed')
        }
      } finally {
        restoreProvider()
      }
      expect(calls).toEqual([])
      const after = await storedMoney(raw, order.orderId)
      expect([after.status, after.capturedMinor, after.refundedMinor]).toEqual([
        statusBefore,
        order.totalMinor,
        0,
      ])
      expect(await raw.count('order_refunds', 'order_id = ?', [order.orderId])).toBe(0)
    })

    // Kills: refunded_minor drifting from the succeeded rows, an over-refund through a sequence, a status that
    // disagrees with the amounts, and refunds refused from processing, shipped or delivered.
    it('AC-3: over generated sequences of refund amounts on provider and manual captures from confirmed, processing, shipped or delivered: each is accepted iff 0 < amount ≤ refundable, Σ succeeded = refundedMinor ≤ capturedMinor ≤ totalMinor after every step, and the status is refunded exactly when refunded = captured', async () => {
      const steps = ['confirmed', 'processing', 'shipped', 'delivered'] as const
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            priceMinor: fc.integer({ min: 2, max: 9_000 }),
            qty: fc.integer({ min: 1, max: 3 }),
            manual: fc.boolean(),
            reach: fc.constantFrom(...steps),
            fractions: fc.array(fc.integer({ min: -10, max: 120 }), { minLength: 1, maxLength: 5 }),
          }),
          async ({ priceMinor, qty, manual, reach, fractions }) => {
            const order = manual
              ? await pendingOrder(priceMinor, qty)
              : await paidOrder(priceMinor, qty)
            const paid = manual ? await markPaid(order.orderId) : null
            expect(paid?.status ?? 200, JSON.stringify(paid?.body)).toBe(200)
            for (const step of steps.slice(1, steps.indexOf(reach) + 1)) {
              const path =
                step === 'processing' ? 'process' : step === 'shipped' ? 'ship' : 'mark-delivered'
              const moved = await admin.call(
                'POST',
                `/api/admin/orders/${order.orderId}/${path}`,
                step === 'shipped' ? { trackingNumber: 'TRK-P1-13', carrier: 'DHL' } : undefined,
              )
              expect(moved.status, `${path}: ${JSON.stringify(moved.body)}`).toBe(200)
            }

            const start = await storedMoney(raw, order.orderId)
            expect(start.capturedMinor).toBe(order.totalMinor)
            let modelRefunded = 0
            for (const percent of fractions) {
              // A percentage of the capture: negative, zero, within and beyond what is left.
              const amountMinor = Math.round((start.capturedMinor * percent) / 100)
              const refundable = start.capturedMinor - modelRefunded
              const res = await refund(order.orderId, amountMinor)
              const expected =
                amountMinor <= 0
                  ? [400, 'validation.failed']
                  : amountMinor > refundable
                    ? [409, 'refund.exceeds_captured']
                    : [200, undefined]
              expect([res.status, res.body.error?.code], `${amountMinor} of ${refundable}`).toEqual(
                expected,
              )
              if (res.status === 200) modelRefunded += amountMinor

              const stored = await storedMoney(raw, order.orderId)
              const rows = await storedRefunds(raw, order.orderId)
              expect(stored.refundedMinor).toBe(modelRefunded)
              expect(sumOf(rows, 'succeeded')).toBe(stored.refundedMinor)
              expect(stored.refundedMinor).toBeLessThanOrEqual(stored.capturedMinor)
              expect(stored.capturedMinor).toBeLessThanOrEqual(stored.totalMinor)
              expect(stored.status === 'refunded').toBe(
                stored.refundedMinor === stored.capturedMinor && stored.capturedMinor > 0,
              )
              const statusOfAmounts =
                stored.refundedMinor === 0
                  ? start.status
                  : stored.refundedMinor === stored.capturedMinor
                    ? 'refunded'
                    : 'partially_refunded'
              expect(stored.status).toBe(statusOfAmounts)
              const read = await adminOrder(admin, order.orderNumber)
              expect(read.payment?.refundedMinor).toBe(stored.refundedMinor)
              expect(read.payment?.refundableMinor).toBe(
                stored.capturedMinor - stored.refundedMinor,
              )
            }
          },
        ),
        { numRuns: 8 },
      )
    }, 180_000)
  })

  describe('AC-4: a refund moves money through the provider', () => {
    // Kills: the adapter skipped (a label-only refund), no idempotency key (a retry refunds twice), and events without
    // the refund they announce.
    it('AC-4: a refund calls payments.refund once with the intent, the amount, reason requested_by_customer and idempotencyKey = the refund row id; the row is succeeded with the provider id; the answer, the events and the read agree', async () => {
      const order = await paidOrder(4_000, 1)
      const amountMinor = 1_500
      provider()
      let res: Awaited<ReturnType<typeof refund>>
      try {
        res = await refund(order.orderId, amountMinor, 'parcel arrived damaged')
      } finally {
        restoreProvider()
      }

      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(calls).toEqual([
        [
          order.paymentIntent.id,
          amountMinor,
          'requested_by_customer',
          { idempotencyKey: row.id, currency: order.currency },
        ],
      ])
      expect(row.status).toBe('succeeded')
      expect(row.amountMinor).toBe(amountMinor)
      expect(row.currency.toUpperCase()).toBe(order.currency.toUpperCase())
      expect(row.providerRefundId).toMatch(/^re_stub_/)
      expect(res.body.data?.refund.id).toBe(row.id)
      expect(res.body.data?.payment?.refundedMinor).toBe(amountMinor)
      expect(res.body.data?.payment?.state).toBe('partially_refunded')

      const partial = (
        await eventsOfType<{
          orderId: string
          refundId: string
          amountMinor: number
          currency: string
        }>(raw, 'order.partially_refunded.v1')
      ).filter((p) => p.orderId === order.orderId)
      expect(partial).toEqual([
        expect.objectContaining({ refundId: row.id, amountMinor, currency: row.currency }),
      ])
      const paymentRefunded = (
        await eventsOfType<{ orderId: string; refundId: string; amountMinor: number }>(
          raw,
          'payment.refunded.v1',
        )
      ).filter((p) => p.orderId === order.orderId)
      expect(paymentRefunded.map((p) => [p.refundId, p.amountMinor])).toEqual([
        [row.id, amountMinor],
      ])
    })

    // Kills: a definite rejection counted as refunded, or left pending so the money is held for good.
    it('AC-4: refund_rejected settles the row failed, leaves refundedMinor 0 and the whole capture refundable, and the status unchanged', async () => {
      const order = await paidOrder(2_000, 1)
      const statusBefore = await orderStatus(raw, order.orderId)
      provider(async () => {
        throw new PaymentError(PaymentErrorCode('refund_rejected'), 'card refused the refund')
      })
      try {
        await refund(order.orderId, 800)
      } finally {
        restoreProvider()
      }

      expect(calls).toHaveLength(1)
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => [r.status, r.amountMinor])).toEqual([['failed', 800]])
      const after = await storedMoney(raw, order.orderId)
      expect(after.refundedMinor).toBe(0)
      expect(after.status).toBe(statusBefore)
      const read = await adminOrder(admin, order.orderNumber)
      expect(read.payment?.refundableMinor).toBe(after.capturedMinor)
      expect(read.payment?.state).toBe('paid')
    })

    // Kills (B2): an unknown outcome (a timeout) settled as failed, so the rest can be refunded again: a double refund.
    it('AC-4: refund_unknown (a timeout) leaves the row pending and counted against refundable: a second refund of the rest + 1 is refused 409 refund.exceeds_captured, and exactly the rest is accepted', async () => {
      const order = await paidOrder(3_000, 1)
      const first = 1_000
      provider(async () => {
        throw new PaymentError(PaymentErrorCode('refund_unknown'), 'Stripe timed out')
      })
      try {
        await refund(order.orderId, first)
      } finally {
        restoreProvider()
      }

      const pending = await storedRefunds(raw, order.orderId)
      expect(pending.map((r) => [r.status, r.amountMinor])).toEqual([['pending', first]])
      const captured = (await storedMoney(raw, order.orderId)).capturedMinor
      expect((await storedMoney(raw, order.orderId)).refundedMinor).toBe(0)
      const read = await adminOrder(admin, order.orderNumber)
      expect(read.payment?.refundableMinor).toBe(captured - first)

      provider()
      try {
        const tooMuch = await refund(order.orderId, captured - first + 1)
        expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBe(409)
        expect(tooMuch.body.error?.code).toBe('refund.exceeds_captured')
        const rest = await refund(order.orderId, captured - first)
        expect(rest.status, JSON.stringify(rest.body)).toBe(200)
      } finally {
        restoreProvider()
      }
      const rows = await storedRefunds(raw, order.orderId)
      expect(sumOf(rows, 'succeeded') + sumOf(rows, 'pending')).toBe(captured)
      expect((await storedMoney(raw, order.orderId)).refundedMinor).toBe(captured - first)
    })

    // Kills: a provider `pending` counted as refunded (or as nothing, so it can be refunded again).
    it('AC-4: a provider answer of pending leaves the row pending, refundedMinor unchanged, and the amount held against refundable', async () => {
      const order = await paidOrder(2_200, 1)
      const amountMinor = 700
      provider(async (paymentId, amount) => ({
        refundId: `re_pending_${randomUUID()}`,
        paymentId,
        amountMinor: amount ?? 0,
        currency: order.currency,
        reason: 'requested_by_customer',
        status: 'pending',
      }))
      try {
        await refund(order.orderId, amountMinor)
      } finally {
        restoreProvider()
      }

      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => [r.status, r.amountMinor])).toEqual([['pending', amountMinor]])
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.refundedMinor).toBe(0)
      const read = await adminOrder(admin, order.orderNumber)
      expect(read.payment?.refundableMinor).toBe(stored.capturedMinor - amountMinor)
      expect(read.payment?.refunds.map((r) => r.status)).toEqual(['pending'])
    })

    // Kills: step 3 trusting a provider answer for another amount or currency than the row's.
    it('AC-4: a provider answer whose amount or currency differs from the row stays pending and moves no amount', async () => {
      for (const skew of ['amount', 'currency'] as const) {
        const order = await paidOrder(2_600, 1)
        const amountMinor = 900
        provider(async (paymentId, amount) => ({
          refundId: `re_skew_${randomUUID()}`,
          paymentId,
          amountMinor: skew === 'amount' ? (amount ?? 0) - 1 : (amount ?? 0),
          currency: skew === 'currency' ? 'USD' : order.currency,
          reason: 'requested_by_customer',
          status: 'succeeded',
        }))
        try {
          await refund(order.orderId, amountMinor)
        } finally {
          restoreProvider()
        }

        const rows = await storedRefunds(raw, order.orderId)
        expect(
          rows.map((r) => [r.status, r.amountMinor]),
          skew,
        ).toEqual([['pending', amountMinor]])
        expect((await storedMoney(raw, order.orderId)).refundedMinor, skew).toBe(0)
      }
    })

    // Kills (B3): a manual or import capture sent to the provider, which never held that money.
    it('AC-4: a manual capture (mark-paid) and an import capture refund with no adapter call, the row settling succeeded at once', async () => {
      const manual = await pendingOrder(1_600, 1)
      expect((await markPaid(manual.orderId)).status).toBe(200)

      const importedId = uuidv7()
      const importedNumber = `WC-${randomUUID().slice(0, 8)}`
      const totalMinor = 4_321
      await k.services.order.importOrder({
        orderId: importedId,
        orderNumber: importedNumber,
        status: 'delivered',
        createdAt: new Date('2025-06-01T10:00:00Z'),
        customerId: null,
        email: `imported-${randomUUID()}@p1-13.test`,
        billingAddress: address,
        shippingAddress: address,
        lineItems: [],
        subtotalMinor: totalMinor,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor,
        currency: 'GBP',
        capturedMinor: totalMinor,
        refundedMinor: 0,
        captureMethod: 'import',
      })
      expect((await storedMoney(raw, importedId)).captureMethod).toBe('import')
      expect((await adminOrder(admin, importedNumber)).payment?.state).toBe('paid')

      provider()
      try {
        const manualRes = await refund(manual.orderId, 600)
        expect(manualRes.status, JSON.stringify(manualRes.body)).toBe(200)
        const importRes = await refund(importedId, totalMinor)
        expect(importRes.status, JSON.stringify(importRes.body)).toBe(200)
      } finally {
        restoreProvider()
      }

      expect(calls).toEqual([])
      for (const [orderId, amountMinor] of [
        [manual.orderId, 600],
        [importedId, totalMinor],
      ] as const) {
        const rows = await storedRefunds(raw, orderId)
        expect(rows.map((r) => [r.status, r.amountMinor])).toEqual([['succeeded', amountMinor]])
        expect((await storedMoney(raw, orderId)).refundedMinor).toBe(sumOf(rows, 'succeeded'))
      }
      expect((await adminOrder(admin, importedNumber)).payment?.state).toBe('refunded')
    })
  })

  describe('AC-6: no confirm without money, no cancel of a captured order', () => {
    // Kills: an admin confirming an order nobody paid.
    it('AC-6: confirm on a +stub-pending order answers 409 order.unpaid and leaves it pending with nothing captured', async () => {
      const order = await pendingOrder()

      const res = await admin.call('POST', `/api/admin/orders/${order.orderId}/confirm`)

      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error?.code).toBe('order.unpaid')
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.status).toBe('pending')
      expect(stored.capturedMinor).toBe(0)
    })

    // Kills (B1): an admin cancelling a paid order, leaving its money unreachable.
    it('AC-6: cancel on a captured order answers 409 order.paid and leaves its status and amounts as they were', async () => {
      const order = await paidOrder(1_900, 1)
      const statusBefore = await orderStatus(raw, order.orderId)

      const res = await admin.call('POST', `/api/admin/orders/${order.orderId}/cancel`, {
        reason: 'changed my mind',
      })

      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error?.code).toBe('order.paid')
      const after = await storedMoney(raw, order.orderId)
      expect(after.status).toBe(statusBefore)
      expect(after.capturedMinor).toBe(order.totalMinor)
      expect(after.refundedMinor).toBe(0)
    })

    // Kills (B1): a refund stranded by a cancel that lands while the provider is moving the money.
    it('AC-6: an admin cancel arriving while a refund is at the provider is refused 409 order.paid, and the refund settles: row succeeded, refundedMinor = the amount', async () => {
      const order = await paidOrder(2_400, 1)
      const amountMinor = 1_000
      let cancel: Awaited<ReturnType<AdminClient['call']>> | undefined
      provider(async (...args) => {
        cancel = await admin.call('POST', `/api/admin/orders/${order.orderId}/cancel`, {
          reason: 'racing the refund',
        })
        return (stubRefund as (...a: unknown[]) => Promise<Refund>)(...args)
      })
      let res: Awaited<ReturnType<typeof refund>>
      try {
        res = await refund(order.orderId, amountMinor)
      } finally {
        restoreProvider()
      }

      expect(calls).toHaveLength(1)
      expect(cancel?.status, JSON.stringify(cancel?.body)).toBe(409)
      expect(cancel?.body.error?.code).toBe('order.paid')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => [r.status, r.amountMinor])).toEqual([['succeeded', amountMinor]])
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.refundedMinor).toBe(sumOf(rows, 'succeeded'))
      expect(stored.status).toBe('partially_refunded')
    })

    // Kills (B1): step 3 failing on a transition the status no longer allows, so the money moved and the row stays
    // pending with refundedMinor never written.
    it('AC-6: when the status moves to one a refund cannot leave (cancelled, by any writer) while the refund is at the provider, step 3 still settles the row succeeded and writes refundedMinor, and keeps the status', async () => {
      const order = await paidOrder(2_000, 1)
      const captured = order.totalMinor
      provider(async (...args) => {
        await k.store.transaction((tx) =>
          k.repos.order.setStatus(tx, order.orderId, 'cancelled', new Date()),
        )
        return (stubRefund as (...a: unknown[]) => Promise<Refund>)(...args)
      })
      let res: Awaited<ReturnType<typeof refund>>
      try {
        res = await refund(order.orderId, captured)
      } finally {
        restoreProvider()
      }

      expect(calls).toHaveLength(1)
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200)
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => [r.status, r.amountMinor])).toEqual([['succeeded', captured]])
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.refundedMinor).toBe(stored.capturedMinor)
      expect(stored.status).toBe('cancelled')
    })
  })

  describe('AC-13: a cancelled order nets to zero; an invalid transition is a 409', () => {
    // Kills: finalize's backstop refund moving money with no capture or refund recorded.
    it("AC-13: a capture delivered for a cancelled order is refunded by finalize's backstop and recorded: capturedMinor = refundedMinor = the amount, one succeeded refund row by system:checkout, paymentState refunded, status cancelled", async () => {
      const order = await pendingOrder(2_750, 2)
      await k.services.checkout.cancel(order.orderId, 'customer changed their mind')

      const answer = await deliverCapture(served.baseUrl, order)

      expect(answer.status, JSON.stringify(answer)).toBe(200)
      expect(answer.data?.reason).toBe('order_cancelled_refunded')
      const stored = await storedMoney(raw, order.orderId)
      expect(stored.status).toBe('cancelled')
      expect(stored.capturedMinor).toBe(order.totalMinor)
      expect(stored.refundedMinor).toBe(stored.capturedMinor)
      expect(stored.captureMethod).toBe('provider')
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => [r.status, r.amountMinor, r.actor])).toEqual([
        ['succeeded', order.totalMinor, 'system:checkout'],
      ])
      expect((await adminOrder(admin, order.orderNumber)).payment?.state).toBe('refunded')
    })

    // Kills: beginCheckout's refund of an inline capture that did not confirm moving money with nothing recorded.
    it('AC-13: an inline capture beginCheckout refunds because it did not confirm (its stock went to another order) is recorded: capturedMinor = refundedMinor = the amount, one succeeded row by system:checkout, paymentState refunded, status cancelled', async () => {
      const qty = 2
      const seeded = await seedVariant(k, qty, { priceMinor: 1_350 })
      let armed = true
      let created: PaymentIntent | undefined
      payments.createPaymentIntent = async (params) => {
        if (!armed) return stubCreate(params)
        armed = false
        // The reservation lapses while the shopper pays, and another shopper takes every unit it gave back.
        const held = await k.store.read((tx) =>
          k.repos.inventoryReservation.findByVariant(tx, seeded.variantId),
        )
        for (const r of held.filter((h) => h.orderRef === params.orderRef)) {
          await k.services.inventory.releaseReservation(r.reservationId, 'expired')
        }
        await checkoutOf(k, seeded, qty)
        created = {
          id: `pi_ac13_${randomUUID()}`,
          clientSecret: `pi_ac13_secret_${randomUUID()}`,
          amountMinor: params.amountMinor,
          currency: params.currency,
          status: 'succeeded',
        }
        return created
      }
      provider(async (paymentId, amountMinor) => ({
        refundId: `re_ac13_${randomUUID()}`,
        paymentId,
        amountMinor: amountMinor ?? created?.amountMinor ?? 0,
        currency: created?.currency ?? 'GBP',
        reason: 'requested_by_customer',
        status: 'succeeded',
      }))
      let result: Awaited<ReturnType<Kernel['services']['checkout']['beginCheckout']>>
      try {
        result = await k.services.checkout.beginCheckout({
          cartToken: await cartWith(k, seeded, qty),
          email: `ac13-inline-${randomUUID()}@p1-13.test`,
          billingAddress: address,
          shippingAddress: address,
        })
      } finally {
        restoreProvider()
      }

      expect(result.payment.status).toBe('failed')
      expect(calls.map((c) => c[0])).toEqual([created!.id])
      const stored = await storedMoney(raw, result.orderId)
      expect(stored.status).toBe('cancelled')
      expect(stored.capturedMinor).toBe(result.totalMinor)
      expect(stored.refundedMinor).toBe(stored.capturedMinor)
      const rows = await storedRefunds(raw, result.orderId)
      expect(rows.map((r) => [r.status, r.amountMinor, r.actor])).toEqual([
        ['succeeded', result.totalMinor, 'system:checkout'],
      ])
      expect((await adminOrder(admin, result.orderNumber)).payment?.state).toBe('refunded')
    })

    // Kills: StatusTransitionError rendered as a 500 fault for the merchant's own mistake.
    it('AC-13: an admin transition the table forbids answers 409 status.invalid_transition and leaves the status: confirm on a confirmed order, process and ship on a pending order, mark-delivered on a confirmed order', async () => {
      const confirmed = await paidOrder(1_100, 1)
      const pending = await pendingOrder(1_200, 1)
      const attempts: Array<[string, string, unknown]> = [
        [confirmed.orderId, 'confirm', undefined],
        [confirmed.orderId, 'mark-delivered', undefined],
        [pending.orderId, 'process', undefined],
        [pending.orderId, 'ship', { trackingNumber: 'TRK-P1-13', carrier: 'DHL' }],
      ]
      for (const [orderId, path, body] of attempts) {
        const before = await orderStatus(raw, orderId)
        const res = await admin.call('POST', `/api/admin/orders/${orderId}/${path}`, body)
        expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(409)
        expect(res.body.error?.code, path).toBe('status.invalid_transition')
        expect(await orderStatus(raw, orderId), path).toBe(before)
      }
    })
  })
})
