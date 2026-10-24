import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../http.js'
import { checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import { deliverCapture, failedFor, orderStatus, paidFor, reservationsFor } from '../webhooks.js'

// AC-3 on one dialect: a captured amount that is not the order's total, or not its currency, never confirms the
// order; the exact total in the same currency does. Sentinel S007 (finalize ignores the paid amount) runs this file.

type Mismatch = 'below' | 'above' | 'currency'

const arbOrderAndPayment = fc.record({
  priceMinor: fc.integer({ min: 1, max: 50_000 }),
  qty: fc.integer({ min: 1, max: 4 }),
  mismatch: fc.constantFrom<Mismatch>('below', 'above', 'currency'),
  delta: fc.integer({ min: 1, max: 5_000 }),
})

/** A paid amount and currency that differ from the order's in exactly the drawn way. */
function paidOf(
  total: number,
  currency: string,
  mismatch: Mismatch,
  delta: number,
): { amountMinor: number; currency: string } {
  switch (mismatch) {
    case 'below':
      return { amountMinor: total - Math.min(delta, total), currency }
    case 'above':
      return { amountMinor: total + delta, currency }
    case 'currency':
      return { amountMinor: total, currency: currency === 'USD' ? 'EUR' : 'USD' }
  }
}

export function underpaymentSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: { serviceRuns: number; httpRuns: number },
): void {
  describe(`no underpayment confirms an order (${dialect})`, () => {
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

    async function expectUnconfirmed(
      started: { orderId: string; totalMinor: number },
      seeded: { variantId: string; initialStock: number },
      qty: number,
    ): Promise<void> {
      expect(await orderStatus(raw, started.orderId)).toBe('pending')
      // The reservation is still held: its row is there and the stock it took is not back.
      expect(await reservationsFor(raw, started.orderId)).toBe(1)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
      expect(await paidFor(raw, started.orderId)).toEqual([])
      const failed = await failedFor(raw, { orderId: started.orderId })
      expect(failed).toHaveLength(1)
      expect(failed[0]!.reason).toMatch(/^amount_mismatch/)
    }

    it(`AC-3: at the service layer, any paid amount ≠ total (below or above) or a different currency leaves the order pending with its reservation and one payment.failed; the exact total then confirms it (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(arbOrderAndPayment, async ({ priceMinor, qty, mismatch, delta }) => {
          const seeded = await seedVariant(k, qty + 2, { priceMinor })
          const started = await checkoutOf(k, seeded, qty)
          expect(started.totalMinor).toBe(priceMinor * qty)
          const paid = paidOf(started.totalMinor, started.currency, mismatch, delta)

          const refused = await k.services.checkout.finalize(started.paymentIntent.id, paid)
          expect(refused.finalized).toBe(false)
          expect(refused.reason).toMatch(/^amount_mismatch/)
          await expectUnconfirmed(started, seeded, qty)

          const confirmed = await k.services.checkout.finalize(started.paymentIntent.id, {
            amountMinor: started.totalMinor,
            currency: started.currency,
          })
          expect(confirmed).toMatchObject({ finalized: true, orderNumber: started.orderNumber })
          expect(await orderStatus(raw, started.orderId)).toBe('confirmed')
          expect(await paidFor(raw, started.orderId)).toHaveLength(1)
          expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
        }),
        { numRuns: opts.serviceRuns },
      )
    }, 120_000)

    it(`AC-3: through the webhook route, a mismatched capture answers 200 finalized: false with an amount_mismatch reason and leaves the order pending; the exact capture answers 200 finalized: true (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(arbOrderAndPayment, async ({ priceMinor, qty, mismatch, delta }) => {
          const seeded = await seedVariant(k, qty + 2, { priceMinor })
          const started = await checkoutOf(k, seeded, qty)
          const paid = paidOf(started.totalMinor, started.currency, mismatch, delta)

          const refused = await deliverCapture(served.baseUrl, started, paid)
          expect(refused.status).toBe(200)
          expect(refused.data?.finalized).toBe(false)
          expect(String(refused.data?.reason)).toMatch(/^amount_mismatch/)
          await expectUnconfirmed(started, seeded, qty)

          const confirmed = await deliverCapture(served.baseUrl, started)
          expect(confirmed.status).toBe(200)
          expect(confirmed.data?.finalized).toBe(true)
          expect(await orderStatus(raw, started.orderId)).toBe('confirmed')
          expect(await paidFor(raw, started.orderId)).toHaveLength(1)
        }),
        { numRuns: opts.httpRuns },
      )
    }, 120_000)

    it(`AC-3: the currency comparison is case-insensitive ISO: the total in the order's currency lower-cased confirms (${dialect})`, async () => {
      const seeded = await seedVariant(k, 3, { priceMinor: 1999 })
      const started = await checkoutOf(k, seeded, 1)
      const result = await k.services.checkout.finalize(started.paymentIntent.id, {
        amountMinor: started.totalMinor,
        currency: started.currency.toLowerCase(),
      })
      expect(result).toMatchObject({ finalized: true, orderNumber: started.orderNumber })
      expect(await orderStatus(raw, started.orderId)).toBe('confirmed')
      expect(await failedFor(raw, { orderId: started.orderId })).toEqual([])
    })
  })
}
