import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PaymentsAdapter, Refund } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../kernel.js'
import {
  adminClient,
  storedMoney,
  storedRefunds,
  sumOf,
  type AdminClient,
  type AdminOrder,
  type RefundCall,
} from '../money.js'
import { openRaw, type RawReader } from '../raw.js'

// `POST /api/admin/orders/:id/refund` takes an optional `requestId`, so a double-clicked refund moves money once: a
// repeat of the same `requestId` for the order answers 200 with the existing refund and moves no money, in turn or
// concurrently, while a distinct refund of the same amount is still made.

type RefundImpl = (...args: unknown[]) => Promise<Refund>

interface RefundAnswer {
  order: AdminOrder
  payment: AdminOrder['payment']
  refund: { id: string; amountMinor: number; status: string }
}

/** A step of a refund sequence: `key` names a requestId (null: none sent), `pct` the amount as a share of the capture. */
const steps = fc.array(
  fc.record({
    key: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
    pct: fc.integer({ min: 1, max: 15 }),
  }),
  { minLength: 1, maxLength: 6 },
)

export function refundRequestIdSuite(
  dialect: Kernel['dialect'],
  /** A fresh, empty database: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`a refund's requestId moves money once (${dialect})`, () => {
    let db: { target: string; drop(): Promise<void> }
    let served: ServedKernel
    let k: Kernel
    let raw: RawReader
    let admin: AdminClient
    let payments: PaymentsAdapter
    let stubRefund: RefundImpl
    let calls: RefundCall[] = []

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

    /** The provider's refund answered by `impl` (the stub's by default), every call recorded. */
    function provider(impl: RefundImpl = stubRefund): void {
      calls = []
      payments.refund = (async (...args: unknown[]) => {
        calls.push(args as RefundCall)
        return impl(...args)
      }) as PaymentsAdapter['refund']
    }

    function restoreProvider(): void {
      payments.refund = stubRefund as PaymentsAdapter['refund']
    }

    /** A checkout the stub pays inline: a confirmed order whose capture is its total. */
    async function paidOrder(priceMinor = 4_000, qty = 2) {
      const seeded = await seedVariant(k, qty + 1, { priceMinor })
      const order = await checkoutOf(k, seeded, qty, `request-id-${randomUUID()}@money.test`)
      expect(order.orderStatus).toBe('confirmed')
      return order
    }

    function refund(orderId: string, amountMinor: number, requestId?: string) {
      return admin.call<RefundAnswer>(
        'POST',
        `/api/admin/orders/${orderId}/refund`,
        requestId === undefined ? { amountMinor } : { amountMinor, requestId },
      )
    }

    // Kills: the route dropping `requestId`, so a retried POST refunds again.
    it('the same requestId sent twice in turn records one refund, calls payments.refund once, and the repeat answers 200 with the same refund id and moves no money', async () => {
      const order = await paidOrder()
      const amount = Math.floor(order.totalMinor / 4)
      const requestId = randomUUID()
      provider()
      let first: Awaited<ReturnType<typeof refund>>
      let afterFirst: Awaited<ReturnType<typeof storedMoney>>
      let second: Awaited<ReturnType<typeof refund>>
      try {
        first = await refund(order.orderId, amount, requestId)
        afterFirst = await storedMoney(raw, order.orderId)
        second = await refund(order.orderId, amount, requestId)
      } finally {
        restoreProvider()
      }

      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect(second.status, JSON.stringify(second.body)).toBe(200)
      expect(second.body.data!.refund.id).toBe(first.body.data!.refund.id)
      const rows = await storedRefunds(raw, order.orderId)
      const stored = await storedMoney(raw, order.orderId)
      expect(rows.map((r) => r.id)).toEqual([first.body.data!.refund.id])
      expect(calls).toHaveLength(rows.length)
      expect(stored.refundedMinor).toBe(afterFirst.refundedMinor)
      expect(stored.refundedMinor).toBe(sumOf(rows, 'succeeded'))
      expect(stored.refundedMinor).toBe(amount)
    })

    // Kills: a check for an existing requestId and an insert with no unique index or lock between them, so two repeats
    // in flight together both find nothing and both refund.
    it('the same requestId sent twice concurrently records one refund, calls payments.refund once, and both answer 200 with the same refund id', async () => {
      const order = await paidOrder()
      const amount = Math.floor(order.totalMinor / 4)
      const requestId = randomUUID()

      // The first request to reach the provider is held there until the other has answered (or reached the provider
      // too, when nothing stops the repeat), so both are in flight across step 1 at once.
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      provider(async (...args: unknown[]) => {
        if (calls.length >= 2) release()
        else await released
        return stubRefund(...args)
      })
      const send = () => refund(order.orderId, amount, requestId).finally(release)
      let answers: Array<Awaited<ReturnType<typeof send>>>
      try {
        answers = await Promise.all([send(), send()])
      } finally {
        restoreProvider()
      }

      expect(
        answers.map((a) => a.status),
        JSON.stringify(answers.map((a) => a.body)),
      ).toEqual([200, 200])
      const ids = answers.map((a) => a.body.data!.refund.id)
      expect(ids[1]).toBe(ids[0])
      const rows = await storedRefunds(raw, order.orderId)
      const stored = await storedMoney(raw, order.orderId)
      expect(rows.map((r) => r.id)).toEqual([ids[0]])
      expect(calls).toHaveLength(rows.length)
      expect(stored.refundedMinor).toBe(sumOf(rows, 'succeeded'))
      expect(stored.refundedMinor).toBe(amount)
    }, 30_000)

    // Kills: a dedup keyed on the amount or the order (a distinct refund swallowed), a requestId shared across refunds,
    // and repeats moving money; and a POST with no requestId no longer refunding each time.
    it('over generated sequences of refunds with repeated, distinct and absent requestIds, one refund row and one provider call per distinct requestId plus one per request without one; each repeat answers its first refund id; Σ succeeded = refundedMinor = Σ first-occurrence amounts', async () => {
      await fc.assert(
        fc.asyncProperty(steps, async (seq) => {
          const order = await paidOrder()
          const captured = order.totalMinor
          const ids = [randomUUID(), randomUUID(), randomUUID()]
          /** The amount and refund id of each requestId's first use. */
          const first = new Map<number, { amount: number; refundId: string }>()
          let expectedRows = 0
          let expectedRefunded = 0

          provider()
          try {
            for (const { key, pct } of seq) {
              const repeat = key === null ? undefined : first.get(key)
              const amount = repeat?.amount ?? Math.max(1, Math.floor((captured * pct) / 100))
              const answer = await refund(
                order.orderId,
                amount,
                key === null ? undefined : ids[key],
              )
              expect(answer.status, JSON.stringify(answer.body)).toBe(200)
              const refundId = answer.body.data!.refund.id
              if (repeat) {
                expect(refundId).toBe(repeat.refundId)
              } else {
                expectedRows += 1
                expectedRefunded += amount
                if (key !== null) first.set(key, { amount, refundId })
              }
            }
          } finally {
            restoreProvider()
          }

          const rows = await storedRefunds(raw, order.orderId)
          const stored = await storedMoney(raw, order.orderId)
          expect(rows).toHaveLength(expectedRows)
          expect(calls).toHaveLength(expectedRows)
          expect(new Set(calls.map((c) => c[3]?.idempotencyKey)).size).toBe(calls.length)
          expect(sumOf(rows, 'succeeded')).toBe(expectedRefunded)
          expect(stored.refundedMinor).toBe(sumOf(rows, 'succeeded'))
          expect(stored.refundedMinor).toBeLessThanOrEqual(stored.capturedMinor)
        }),
        { numRuns: 8 },
      )
    }, 180_000)
  })
}
