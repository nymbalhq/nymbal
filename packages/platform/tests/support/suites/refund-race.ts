import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PaymentsAdapter, Refund } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../kernel.js'
import { adminClient, storedMoney, storedRefunds, sumOf, type AdminClient } from '../money.js'
import { openRaw, type RawReader } from '../raw.js'

// AC-5 on one dialect: two admin refunds of one order, sent together, that between them ask for more than was
// captured. The first to reach the provider is held there until the other request has answered (or has reached the
// provider too, when nothing serialises them), so both requests are in flight at once. The order's row lock
// (`OrderRepository.lock`: Postgres FOR UPDATE, SQLite BEGIN IMMEDIATE) keeps one of them out.

type RefundImpl = (...args: unknown[]) => Promise<Refund>

/** A capture C and two amounts a, b, each 1 ≤ x ≤ C, with a + b > C. */
const race = fc
  .record({
    priceMinor: fc.integer({ min: 2, max: 20_000 }),
    qty: fc.integer({ min: 1, max: 3 }),
    pa: fc.integer({ min: 1, max: 100 }),
    pb: fc.integer({ min: 1, max: 100 }),
  })
  .filter(({ pa, pb }) => pa + pb > 100)

export function refundRaceSuite(
  dialect: Kernel['dialect'],
  /** A fresh, empty database: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`AC-5: concurrent refunds (${dialect})`, () => {
    let db: { target: string; drop(): Promise<void> }
    let served: ServedKernel
    let k: Kernel
    let raw: RawReader
    let admin: AdminClient
    let payments: PaymentsAdapter
    let stubRefund: RefundImpl

    beforeAll(async () => {
      db = await fresh()
      k = await createKernel(
        dialect === 'sqlite'
          ? { dialect, sqlitePath: db.target }
          : { dialect, postgresUrl: db.target },
      )
      served = await serveKernel(k)
      raw = openRaw(dialect, db.target)
      admin = await adminClient(k, served.baseUrl)
      payments = k.app.adapters.payments
      stubRefund = payments.refund.bind(payments) as RefundImpl
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
      await db?.drop()
    })

    it('AC-5: over generated captures C and amounts a, b ≤ C with a + b > C, two concurrent refunds of a and b: exactly one succeeds, the other answers 409 refund.exceeds_captured, the provider is called once, and Σ succeeded = refundedMinor = the winner’s amount ≤ C', async () => {
      await fc.assert(
        fc.asyncProperty(race, async ({ priceMinor, qty, pa, pb }) => {
          const seeded = await seedVariant(k, qty + 1, { priceMinor })
          const order = await checkoutOf(k, seeded, qty, `race-${randomUUID()}@money.test`)
          expect(order.orderStatus).toBe('confirmed')
          const captured = order.totalMinor
          expect(captured).toBe(priceMinor * qty)
          const a = Math.ceil((captured * pa) / 100)
          const b = Math.ceil((captured * pb) / 100)

          let release!: () => void
          const released = new Promise<void>((resolve) => {
            release = resolve
          })
          let arrivals = 0
          payments.refund = async (...args: unknown[]) => {
            arrivals += 1
            if (arrivals >= 2) release()
            else await released
            return stubRefund(...args)
          }
          const send = (amountMinor: number) =>
            admin
              .call('POST', `/api/admin/orders/${order.orderId}/refund`, { amountMinor })
              .finally(release)
          let answers: Array<Awaited<ReturnType<typeof send>>>
          try {
            answers = await Promise.all([send(a), send(b)])
          } finally {
            payments.refund = stubRefund as PaymentsAdapter['refund']
          }

          const statuses = answers.map((r) => r.status)
          const won = answers.filter((r) => r.status === 200)
          const lost = answers.filter((r) => r.status !== 200)
          expect(won, JSON.stringify(statuses)).toHaveLength(1)
          expect(lost.map((r) => [r.status, r.body.error?.code])).toEqual([
            [409, 'refund.exceeds_captured'],
          ])
          expect(arrivals).toBe(1)
          const winner = answers[0]!.status === 200 ? a : b
          const rows = await storedRefunds(raw, order.orderId)
          const stored = await storedMoney(raw, order.orderId)
          expect(rows.filter((r) => r.status === 'succeeded')).toHaveLength(1)
          expect(sumOf(rows, 'succeeded')).toBe(winner)
          expect(stored.refundedMinor).toBe(sumOf(rows, 'succeeded'))
          expect(stored.refundedMinor).toBeLessThanOrEqual(stored.capturedMinor)
        }),
        { numRuns: 8 },
      )
    }, 180_000)
  })
}
