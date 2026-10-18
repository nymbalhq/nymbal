import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_CART_ABANDONED,
  EVT_INVENTORY_RESERVED,
  EVT_PAYMENT_FAILED,
  type NymbalEvent,
} from '@nymbalhq/types'
import { seedVariant, type Kernel } from '../kernel.js'
import { eventRows, maxSeq, placeholders } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'

// P1-03 AC-4 (atomic append) and AC-5 (no event lost under concurrency) on one dialect. The `events` table is read
// through a second connection, so a row counts only once it is committed.

export function outboxSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: { propertyRuns: number },
): void {
  describe(`the outbox (${dialect})`, () => {
    let k: Kernel
    let raw: RawReader
    /** Every event the bus delivered to a catch-all subscriber, in delivery order. */
    const delivered: NymbalEvent<unknown>[] = []

    beforeAll(async () => {
      k = await start()
      raw = openRaw(k.dialect, k.target)
      await k.eventBus.subscribe('*', (event) => {
        delivered.push(event)
      })
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await k?.close()
    })

    function publishTwo(tag: string) {
      return async (): Promise<[string, string]> => {
        const failed = await k.publisher.publish(EVT_PAYMENT_FAILED, {
          paymentId: `pi_${tag}`,
          orderId: '',
          reason: 'card_declined',
        })
        const abandoned = await k.publisher.publish(EVT_CART_ABANDONED, {
          cartId: `cart_${tag}`,
          lastActivityAt: new Date().toISOString(),
        })
        return [failed.id, abandoned.id]
      }
    }

    it('AC-4: a transaction that publishes two events and then throws leaves no events row and delivers neither', async () => {
      const ids: string[] = []
      const boom = new Error('abort after two publishes')
      const two = publishTwo(randomUUID())

      await expect(
        k.store.transaction(async () => {
          ids.push(...(await two()))
          throw boom
        }),
      ).rejects.toBe(boom)

      expect(ids).toHaveLength(2)
      expect(await raw.count('events', `id IN (${placeholders(2)})`, ids)).toBe(0)
      expect(delivered.filter((e) => ids.includes(e.id)).map((e) => e.id)).toEqual([])
    })

    it('AC-4: a committed transaction leaves both rows in publish order (seq ascending), both delivered, in that order', async () => {
      const ids = await k.store.transaction(publishTwo(randomUUID()))

      const rows = await eventRows(raw, `id IN (${placeholders(2)})`, ids)
      expect(rows.map((r) => r.id)).toEqual(ids)
      expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq)
      expect(rows.map((r) => r.type)).toEqual([EVT_PAYMENT_FAILED, EVT_CART_ABANDONED])
      // The row holds the whole envelope the subscriber got.
      expect(rows.map((r) => r.envelope.id)).toEqual(ids)
      expect(rows.filter((r) => r.deliveredAt == null).map((r) => r.id)).toEqual([])
      expect(delivered.filter((e) => ids.includes(e.id)).map((e) => e.id)).toEqual(ids)
    })

    it(`AC-5: property: 50 concurrent reserveStock calls on stock 0..60: every new events row is delivered, the subscriber received exactly the rows' ids with no duplicate, and inventory.reserved.v1 rows = successful reservations (${opts.propertyRuns} runs)`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 60 }),
          fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 50, maxLength: 50 }),
          async (initial, qtys) => {
            const seeded = await seedVariant(k, initial)
            const before = await maxSeq(raw)
            const from = delivered.length

            const settled = await Promise.allSettled(
              qtys.map((qty) => k.services.inventory.reserveStock(seeded.variantId, qty)),
            )

            const successes = settled.filter((r) => r.status === 'fulfilled').length
            const rows = await eventRows(raw, 'seq > ?', [before])
            const received = delivered.slice(from).map((e) => e.id)
            const label = `initial ${initial}, ${successes} reservations`

            expect(
              rows.filter((r) => r.deliveredAt == null).map((r) => `${r.seq} ${r.type}`),
              `${label}: undelivered rows`,
            ).toEqual([])
            expect(received.length, `${label}: an event delivered twice`).toBe(
              new Set(received).size,
            )
            expect([...received].sort(), `${label}: delivered ids vs row ids`).toEqual(
              rows.map((r) => r.id).sort(),
            )
            expect(
              rows.filter((r) => r.type === EVT_INVENTORY_RESERVED).length,
              `${label}: inventory.reserved.v1 rows`,
            ).toBe(successes)
          },
        ),
        { numRuns: opts.propertyRuns },
      )
    }, 120_000)
  })
}
