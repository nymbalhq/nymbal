import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, seedVariant, type Kernel } from '../kernel.js'
import { addLine, putCode, seedPromotion, uniqueCode } from '../promotions.js'
import { openRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'

// AC-20: N shoppers, each from their own cart and on their own variant, check out at once on one code capped at k. The
// cart and variant row locks are per contender, so only the promotion's row lock can serialize them: exactly k orders
// carry the discount and exactly k redemptions exist, however the checkouts interleave. Postgres is the run that proves
// it; SQLite serializes by accident.

interface CheckoutAnswer {
  orderId: string
}

export function promotionRaceSuite(start: () => Promise<Kernel>): void {
  describe('AC-20: parallel checkouts on a capped code', () => {
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

    it('AC-20: exactly k of N parallel checkouts carry the discount, promotion_redemptions has exactly k rows for the code, and the rest are at full price', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 4, max: 12 }),
          fc.integer({ min: 1, max: 3 }),
          async (contenders, cap) => {
            const code = uniqueCode('RACE')
            const promotion = await seedPromotion(k, {
              code,
              kind: 'percent',
              percentBps: 1000,
              usageCap: cap,
            })
            const shops = await Promise.all(
              Array.from({ length: contenders }, async () => {
                // A variant per contender: a shared one's row lock would serialize the checkouts instead.
                const seeded = await seedVariant(k, 5, { priceMinor: 2000 })
                const shop = await primedShopper(served.baseUrl)
                expect((await shop.call('GET', '/api/cart')).status).toBe(200)
                expect((await addLine(shop, seeded, 1)).status).toBe(200)
                const added = await putCode(shop, code)
                expect(added.status, JSON.stringify(added.body)).toBe(200)
                expect(added.body.data!.totals.discountTotalMinor).toBe(200)
                return shop
              }),
            )

            const answers = await Promise.all(
              shops.map((shop, i) =>
                shop.call<CheckoutAnswer>('POST', '/api/checkout', {
                  email: `race-${i}-${randomUUID()}+stub-pending@promo.test`,
                  billingAddress: address,
                  shippingAddress: address,
                }),
              ),
            )

            for (const answer of answers) {
              expect(answer.status, JSON.stringify(answer.body)).toBe(200)
            }
            const ids = answers.map((a) => a.body.data!.orderId)
            const rows = await Promise.all(
              ids.map((id) =>
                raw.one<{
                  discount_total_minor: number
                  total_minor: number
                  subtotal_minor: number
                }>(
                  'SELECT discount_total_minor, total_minor, subtotal_minor FROM orders WHERE id = ?',
                  [id],
                ),
              ),
            )
            const discounted = rows.filter((r) => Number(r.discount_total_minor) > 0)
            expect(discounted.length, `${contenders} checkouts, cap ${cap}`).toBe(cap)
            expect(
              rows.filter((r) => Number(r.total_minor) === Number(r.subtotal_minor)).length,
            ).toBe(contenders - cap)
            expect(
              await raw.count('promotion_redemptions', 'promotion_id = ?', [promotion.id]),
            ).toBe(cap)
          },
        ),
        { numRuns: 5 },
      )
    }, 120_000)
  })
}
