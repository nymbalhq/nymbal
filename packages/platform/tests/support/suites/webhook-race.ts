import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../http.js'
import { seedVariant, type Kernel } from '../kernel.js'
import { race } from '../proof-kit.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import {
  adjustmentsFor,
  deliverCapture,
  expiredCheckout,
  failedFor,
  historyNotes,
  orderStatus,
  paidFor,
  type WebhookAnswer,
} from '../webhooks.js'
import { unaudited } from '../write-audit.js'

// AC-12 on one dialect: two deliveries of one captured payment at the same instant, against a pending order whose
// reservation the sweeper already released, so the reservation's DELETE … RETURNING is not what keeps the second
// finalize out: one order.paid, stock taken once. The last-unit cases seed exactly the order's qty, so the losing
// delivery's re-take finds stock 0 after the winner confirmed, and must not record stock_unavailable against its
// stale pending snapshot.

interface Stats {
  orderCount: number
  totalSpentMinor: number
}

async function statsOf(raw: RawReader, customerId: string): Promise<Stats> {
  const row = await raw.one<{ order_count: number | string; total_spent_minor: number | string }>(
    'SELECT order_count, total_spent_minor FROM customers WHERE id = ?',
    [customerId],
  )
  return { orderCount: Number(row.order_count), totalSpentMinor: Number(row.total_spent_minor) }
}

export function webhookRaceSuite(dialect: Kernel['dialect'], start: () => Promise<Kernel>): void {
  describe(`concurrent webhook deliveries (${dialect})`, () => {
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

    async function customer(): Promise<string> {
      const id = uuidv7()
      await unaudited(() =>
        k.store.transaction((tx) =>
          k.repos.customer.insert(tx, {
            id,
            email: `race-${randomUUID()}@webhook.test`,
            passwordHash: 'x',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      )
      return id
    }

    /**
     * Two deliveries started in one synchronous pass against a released-reservation pending order, on a variant
     * seeded at `stock`.
     */
    async function raceDeliveries(eventIds: [string, string], stock = 5) {
      const qty = 2
      const seeded = await seedVariant(k, stock)
      const customerId = await customer()
      const started = await expiredCheckout(k, seeded, qty, { customerId })
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock)
      const adjustmentsBefore = await adjustmentsFor(raw, seeded.variantId)
      const statsBefore = await statsOf(raw, customerId)

      const outcome = await race<WebhookAnswer>(
        (i) => deliverCapture(served.baseUrl, started, { eventId: eventIds[i]! }),
        { contenders: 2 },
      )

      expect(outcome.lost).toEqual([])
      expect(outcome.won.map((a) => a.status)).toEqual([200, 200])
      expect(await orderStatus(raw, started.orderId)).toBe('confirmed')
      expect(await paidFor(raw, started.orderId)).toHaveLength(1)
      // Every captured payment ends in exactly one recorded outcome: the order.paid, and no failure beside it.
      expect(await failedFor(raw, { orderId: started.orderId })).toEqual([])
      expect(
        (await historyNotes(raw, started.orderId)).filter((n) =>
          n.startsWith('captured payment not applied'),
        ),
      ).toEqual([])
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
      // One line, so one stock adjustment for this finalize however many deliveries ran.
      expect((await adjustmentsFor(raw, seeded.variantId)) - adjustmentsBefore).toBe(1)
      const statsAfter = await statsOf(raw, customerId)
      expect(statsAfter.orderCount - statsBefore.orderCount).toBe(1)
      expect(statsAfter.totalSpentMinor - statsBefore.totalSpentMinor).toBe(started.totalMinor)
      return outcome
    }

    it(`AC-12: two concurrent deliveries of one event id: both 200, one order.paid, one stock adjustment, stock = initial − qty, customer stats incremented once (${dialect})`, async () => {
      const eventId = `evt_${randomUUID()}`
      await raceDeliveries([eventId, eventId])
    }, 60_000)

    it(`AC-12: two concurrent deliveries of two event ids for one intent: both 200, one order.paid, one stock adjustment, stock = initial − qty, customer stats incremented once (${dialect})`, async () => {
      await raceDeliveries([`evt_${randomUUID()}`, `evt_${randomUUID()}`])
    }, 60_000)

    it(`AC-12: last units, two concurrent deliveries of one event id: one order.paid, order confirmed, stock 0, no payment.failed and no "captured payment not applied" note (${dialect})`, async () => {
      const eventId = `evt_${randomUUID()}`
      await raceDeliveries([eventId, eventId], 2)
    }, 60_000)

    it(`AC-12: last units, two concurrent deliveries of two event ids for one intent: one order.paid, order confirmed, stock 0, no payment.failed and no "captured payment not applied" note (${dialect})`, async () => {
      await raceDeliveries([`evt_${randomUUID()}`, `evt_${randomUUID()}`], 2)
    }, 60_000)
  })
}
