import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OrderHistoryEntry, PaymentsAdapter, Refund } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient, type AdminOrder } from '../support/money.js'
import { deliverCapture } from '../support/webhooks.js'

// P1-13 store walk at e3eec31 (`admin-orders.timeline`, AC-11): the admin order Timeline read "refund of 1000 GBP" for a
// £10.00 refund, the duplicate-capture note carried no amount, and `refund.request_reused` named minor units. A merchant
// reads £1000 for £10. Every amount the refund path writes into a history note or a 409 message reads as money in the
// order's currency, as the admin shows money (`apps/admin/src/lib/money.ts`: en-GB, two decimals). Kills: a note or
// message built from `amountMinor` and a currency code, and a duplicate-capture note that names no amount.

type RefundImpl = NonNullable<PaymentsAdapter['refund']>

interface AdminOrderWithHistory extends AdminOrder {
  history: OrderHistoryEntry[]
}

/** The amount as the admin shows it: £10.00 for 1000 GBP. */
function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100)
}

/**
 * True when `text` carries `amountMinor` as a bare number: digits not joined to other digits, a decimal point or a
 * thousands separator. £10.00 does not carry 1000; "refund of 1000 GBP" does.
 */
function bareMinor(text: string, amountMinor: number): boolean {
  return new RegExp(`(?<![\\d.,])${amountMinor}(?![\\d.,])`).test(text)
}

describe('P1-13 store walk: money in the admin timeline and refund messages reads as money (sqlite)', () => {
  let k: Kernel
  let served: ServedKernel
  let admin: AdminClient
  let payments: PaymentsAdapter
  let stubRefund: RefundImpl

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    admin = await adminClient(k, served.baseUrl)
    payments = k.app.adapters.payments
    stubRefund = payments.refund.bind(payments)
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  /** A checkout the stub pays inline: a confirmed order whose capture is its total. */
  async function paidOrder(priceMinor: number) {
    const seeded = await seedVariant(k, 2, { priceMinor })
    const order = await checkoutOf(k, seeded, 1, `timeline-${randomUUID()}@p1-13.test`)
    expect(order.orderStatus).toBe('confirmed')
    return order
  }

  function refund(orderId: string, amountMinor: number, requestId?: string) {
    return admin.call<unknown>(
      'POST',
      `/api/admin/orders/${orderId}/refund`,
      requestId === undefined ? { amountMinor } : { amountMinor, requestId },
    )
  }

  async function notes(orderNumber: string): Promise<string[]> {
    const res = await admin.call<AdminOrderWithHistory>('GET', `/api/admin/orders/${orderNumber}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.data!.history.map((h) => h.note)
  }

  // Kills: `refund of ${amountMinor} ${currency}` in the history note (the walk's "refund of 1000 GBP").
  it('AC-11 (timeline): a partial refund of 1000 then the rest of a 3900 GBP order shows "£10.00" and "£29.00" in GET /api/admin/orders/:n history, and no note shows 1000 or 2900 as a bare number', async () => {
    const order = await paidOrder(3_900)
    expect(order.currency).toBe('GBP')
    expect((await refund(order.orderId, 1_000)).status).toBe(200)
    expect((await refund(order.orderId, order.totalMinor - 1_000)).status).toBe(200)

    const history = await notes(order.orderNumber)
    expect(
      history.some((n) => n.includes('£10.00')),
      JSON.stringify(history),
    ).toBe(true)
    expect(
      history.some((n) => n.includes(money(order.totalMinor - 1_000, 'GBP'))),
      JSON.stringify(history),
    ).toBe(true)
    for (const n of history) {
      expect(bareMinor(n, 1_000), n).toBe(false)
      expect(bareMinor(n, order.totalMinor - 1_000), n).toBe(false)
    }
  })

  // Kills: the same, for any amount: a note that formats some amounts (a lucky round number) and not others.
  it('AC-11 (timeline): over generated prices and partial refund amounts, the order history gains a note showing the refund as money in the order currency, and no note shows the refund or the total as a bare minor-unit number', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 2_500_000 }),
        fc.integer({ min: 1, max: 99 }),
        async (priceMinor, pct) => {
          const order = await paidOrder(priceMinor)
          const amount = Math.max(1, Math.floor((order.totalMinor * pct) / 100))
          const before = await notes(order.orderNumber)
          const answer = await refund(order.orderId, amount)
          expect(answer.status, JSON.stringify(answer.body)).toBe(200)

          const after = await notes(order.orderNumber)
          const added = after.slice(before.length)
          expect(after.length).toBeGreaterThan(before.length)
          expect(
            added.some((n) => n.includes(money(amount, order.currency))),
            JSON.stringify(added),
          ).toBe(true)
          for (const n of after) {
            expect(bareMinor(n, amount), n).toBe(false)
            expect(bareMinor(n, order.totalMinor), n).toBe(false)
          }
        },
      ),
      { numRuns: 8 },
    )
  }, 120_000)

  // Kills: 409 messages built from minor units ("already refunded 1000", "Refund of 5000 exceeds the 3900").
  it('AC-3 (messages): over generated amounts, refund.request_reused names the earlier refund as money and refund.exceeds_captured names the refundable as money; neither message shows an amount as a bare minor-unit number', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 2_500_000 }),
        fc.integer({ min: 1, max: 49 }),
        async (priceMinor, pct) => {
          const order = await paidOrder(priceMinor)
          const first = Math.max(1, Math.floor((order.totalMinor * pct) / 100))
          // The route takes a UUID; it is cut out of the message before the amounts are read, as is the order number.
          const requestId = randomUUID()
          expect((await refund(order.orderId, first, requestId)).status).toBe(200)

          const reused = await refund(order.orderId, first + 1, requestId)
          expect(reused.status, JSON.stringify(reused.body)).toBe(409)
          expect(reused.body.error?.code).toBe('refund.request_reused')
          const reusedText = reused.body
            .error!.message.replaceAll(requestId, '')
            .replaceAll(order.orderNumber, '')
          expect(reusedText.includes(money(first, order.currency)), reusedText).toBe(true)
          expect(bareMinor(reusedText, first), reusedText).toBe(false)
          expect(bareMinor(reusedText, first + 1), reusedText).toBe(false)

          const refundable = order.totalMinor - first
          const over = refundable + 1
          const exceeds = await refund(order.orderId, over)
          expect(exceeds.status, JSON.stringify(exceeds.body)).toBe(409)
          expect(exceeds.body.error?.code).toBe('refund.exceeds_captured')
          const exceedsText = exceeds.body.error!.message.replaceAll(order.orderNumber, '')
          expect(exceedsText.includes(money(refundable, order.currency)), exceedsText).toBe(true)
          expect(bareMinor(exceedsText, refundable), exceedsText).toBe(false)
          expect(bareMinor(exceedsText, over), exceedsText).toBe(false)
        },
      ),
      { numRuns: 6 },
    )
  }, 120_000)

  // Kills: "captured payment not applied: duplicate_capture_refunded" with no amount, or with the amount in minor units.
  it('AC-11 (timeline): over generated prices, a provider capture of a marked-paid order is refunded and its history note shows the refunded capture as money in the order currency, never as a bare minor-unit number', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 200, max: 2_500_000 }), async (priceMinor) => {
        const seeded = await seedVariant(k, 2, { priceMinor })
        const order = await checkoutOf(k, seeded, 1)
        expect(order.orderStatus).toBe('pending')
        const marked = await admin.call<AdminOrder>(
          'POST',
          `/api/admin/orders/${order.orderId}/mark-paid`,
          {},
        )
        expect(marked.status, JSON.stringify(marked.body)).toBe(200)
        const before = await notes(order.orderNumber)

        payments.refund = async (paymentId, amountMinor) =>
          ({
            refundId: `re_timeline_${randomUUID()}`,
            paymentId,
            amountMinor: amountMinor ?? 0,
            currency: order.currency,
            reason: 'requested_by_customer',
            status: 'succeeded',
          }) satisfies Refund
        try {
          await deliverCapture(served.baseUrl, order)
        } finally {
          payments.refund = stubRefund
        }

        const after = await notes(order.orderNumber)
        const added = after.slice(before.length)
        const duplicate = added.filter((n) => n.includes('duplicate_capture'))
        expect(duplicate.length, JSON.stringify(added)).toBeGreaterThan(0)
        for (const n of duplicate) {
          expect(n.includes(money(order.totalMinor, order.currency)), n).toBe(true)
        }
        for (const n of after) expect(bareMinor(n, order.totalMinor), n).toBe(false)
      }),
      { numRuns: 4 },
    )
  }, 120_000)
})
