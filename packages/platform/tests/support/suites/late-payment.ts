import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../http.js'
import { checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import {
  deliverCapture,
  expiredCheckout,
  failedFor,
  historyNotes,
  orderStatus,
  paidFor,
  processedCount,
  reservationsFor,
} from '../webhooks.js'

// P1-05 AC-11 on one dialect: a payment captured after the reservation sweeper released the order's reservation.
// Kills: a finalize whose commitReservation throws NotFoundError on the released row (404, rollback, nothing recorded,
// Stripe retries for three days), and a re-take that does not use the conditional decrement.

export function latePaymentSuite(dialect: Kernel['dialect'], start: () => Promise<Kernel>): void {
  describe(`late payment after the reservation expired (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    it(`AC-11a: stock still free: the capture answers 200 finalized: true, the order is confirmed, stock = initial − qty, and there is one order.paid (${dialect})`, async () => {
      const qty = 2
      const seeded = await seedVariant(k, 5)
      const started = await expiredCheckout(k, seeded, qty)
      // The sweeper did its work: the reservation row is gone and the stock is back.
      expect(await reservationsFor(raw, started.orderId)).toBe(0)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock)
      expect(await orderStatus(raw, started.orderId)).toBe('pending')

      const answer = await deliverCapture(served.baseUrl, started)

      expect(answer.status).toBe(200)
      expect(answer.data?.finalized).toBe(true)
      expect(await orderStatus(raw, started.orderId)).toBe('confirmed')
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
      expect(await paidFor(raw, started.orderId)).toHaveLength(1)
      expect(await failedFor(raw, { orderId: started.orderId })).toEqual([])
    })

    it(`AC-11b: stock taken by another order in between: 200 finalized: false with reason stock_unavailable, the order stays pending, the other order's stock is untouched, one payment.failed, the event is processed and the history note names the reason (${dialect})`, async () => {
      const qty = 2
      const seeded = await seedVariant(k, qty)
      const late = await expiredCheckout(k, seeded, qty)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock)
      // Another shopper takes every unit the sweeper gave back.
      const other = await checkoutOf(k, seeded, qty)
      expect(await stockOf(raw, seeded.variantId)).toBe(0)
      const eventId = `evt_${randomUUID()}`

      const answer = await deliverCapture(served.baseUrl, late, { eventId })

      expect(answer.status).toBe(200)
      expect(answer.data?.finalized).toBe(false)
      expect(String(answer.data?.reason)).toMatch(/^stock_unavailable/)
      expect(String(answer.data?.reason)).toContain(seeded.variantId)
      expect(await orderStatus(raw, late.orderId)).toBe('pending')
      expect(await paidFor(raw, late.orderId)).toEqual([])
      // The other order's reservation and the stock it holds are untouched: no re-take went below zero.
      expect(await reservationsFor(raw, other.orderId)).toBe(1)
      expect(await stockOf(raw, seeded.variantId)).toBe(0)
      expect(await orderStatus(raw, other.orderId)).toBe('pending')
      const failed = await failedFor(raw, { orderId: late.orderId })
      expect(failed).toHaveLength(1)
      expect(failed[0]!.reason).toMatch(/^stock_unavailable/)
      expect(await processedCount(raw, eventId)).toBe(1)
      expect((await historyNotes(raw, late.orderId)).some((n) => /stock_unavailable/.test(n))).toBe(
        true,
      )
      const again = await deliverCapture(served.baseUrl, late, { eventId })
      expect(again.status).toBe(200)
      expect(again.data?.deduped).toBe(true)
    })
  })
}
