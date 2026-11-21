import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PaymentError, paymentState, type PaymentsAdapter, type Refund } from '@nymbalhq/types'
import { adminSession, type AdminSession } from '../audit.js'
import { dataOf, instantAfter, orderView, readAsOf } from '../history.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { createKernel, type Kernel } from '../kernel.js'
import {
  adminClient,
  storedMoney,
  storedRefunds,
  sumOf,
  type AdminClient,
  type AdminOrder,
} from '../money.js'
import {
  allRefundEvents,
  answerListWith,
  customerSpend,
  deliverRefunded,
  insertRefund,
  listed,
  paidOrder,
  reconcileOrder,
  reconcilePayment,
  refundedDelivery,
  refundEvents,
  refundHistory,
  registeredCustomer,
  type ListedRefund,
  type PaidOrder,
} from '../provider-refunds.js'
import { openRaw, type RawReader } from '../raw.js'
import { captureLogs, type LogCapture } from '../settings.js'
import { deliver, type WebhookAnswer } from '../webhooks.js'
import { unaudited } from '../write-audit.js'

// A dashboard refund and a pending row, on one dialect, through the kernel's real route and refund service over a
// served kernel: the stub adapter's own `payment.refunded` body makes a provider refund, a test's list stands in for
// the provider's answer where the row's outcome is the point.

const HOUR = 3_600_000
type RefundImpl = (...args: unknown[]) => Promise<Refund>

/** A plan of provider refunds: their amounts and the order they are delivered in, repeats included. */
const plans = fc
  .record({
    weights: fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 4 }),
    reachCapture: fc.boolean(),
    order: fc.array(fc.nat(), { minLength: 8, maxLength: 8 }),
    repeats: fc.array(fc.record({ which: fc.nat(), sameEvent: fc.boolean() }), { maxLength: 3 }),
  })
  .map(({ weights, reachCapture, order, repeats }) => {
    const captured = 10_000
    const budget = reachCapture ? captured : captured - 1
    const total = weights.reduce((sum, w) => sum + w, 0)
    const amounts = weights.map((w) => Math.floor((w * budget) / total))
    amounts[0]! += budget - amounts.reduce((sum, a) => sum + a, 0)
    // Every first delivery uses the refund's own event id; a repeat uses it again or a fresh one.
    const firsts = amounts.map((_, which) => ({ which, ownEvent: true }))
    const again = repeats.map((r) => ({
      which: r.which % amounts.length,
      ownEvent: r.sameEvent,
    }))
    const schedule = [...firsts, ...again]
      .map((step, i) => ({ step, key: order[i % order.length]! }))
      .sort((a, b) => a.key - b.key)
      .map((s) => s.step)
    return { captured, reachCapture, amounts, schedule }
  })

export function providerRefundSuite(
  dialect: Kernel['dialect'],
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
  runs: number,
): void {
  describe(`provider refunds settle on the order (${dialect})`, () => {
    let db: { target: string; drop(): Promise<void> }
    let served: ServedKernel
    let k: Kernel
    let raw: RawReader
    let admin: AdminClient
    let session: AdminSession
    let payments: PaymentsAdapter
    let stubRefund: RefundImpl
    let logs: LogCapture

    beforeAll(async () => {
      db = await fresh()
      logs = captureLogs()
      k = await createKernel(
        dialect === 'sqlite'
          ? { dialect, sqlitePath: db.target, logger: logs.logger }
          : { dialect, postgresUrl: db.target, logger: logs.logger },
      )
      served = await serveKernel(k)
      raw = openRaw(dialect, db.target)
      admin = await adminClient(k, served.baseUrl)
      session = await adminSession(k, served.baseUrl)
      payments = k.app.adapters.payments
      stubRefund = payments.refund.bind(payments) as RefundImpl
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
      await db?.drop()
    })

    function refundAsAdmin(order: PaidOrder, amountMinor: number) {
      return admin.call<{ refund: { id: string; status: string } }>(
        'POST',
        `/api/admin/orders/${order.orderId}/refund`,
        { amountMinor },
      )
    }

    async function adminRead(orderNumber: string): Promise<AdminOrder> {
      await k.app.relay.drain()
      const res = await admin.call<AdminOrder>('GET', `/api/admin/orders/${orderNumber}`)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.data!
    }

    // Defect: a repeat counts twice, a partial is read as the running total, or a provider refund writes a status.
    it(`AC-4: property: dashboard partial refunds delivered in any order, repeated under their own or a new event id, make one succeeded row each as system:provider, refundedMinor = Σ rows ≤ captured and payment.state = paymentState after each delivery, status unchanged; each has one history row at from = to = status, one payment.refunded.v1 and one order event, the last to reach the capture order.refunded.v1; stats fall by the sum; ?at= equals the admin read (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(plans, async ({ captured, reachCapture, amounts, schedule }) => {
          const customerId = await registeredCustomer(k)
          const order = await paidOrder(k, { priceMinor: captured, customerId })
          const spentBefore = await customerSpend(raw, customerId)
          const statusBefore = order.status
          const ids = amounts.map(() => `re_dash_${randomUUID()}`)
          const eventOf = amounts.map(() => `evt_${randomUUID()}`)
          const delivered = new Set<number>()
          let lastNew = -1

          for (const { which, ownEvent } of schedule) {
            const answer = await deliverRefunded(served.baseUrl, order.intentId, {
              eventId: ownEvent ? eventOf[which]! : `evt_${randomUUID()}`,
              refund: { id: ids[which]!, amountMinor: amounts[which]! },
            })
            expect(answer.status, JSON.stringify(answer)).toBe(200)
            if (!delivered.has(which)) lastNew = which
            delivered.add(which)

            const rows = await storedRefunds(raw, order.orderId)
            const expectedIds = [...delivered].map((i) => ids[i]!).sort()
            expect(rows.map((r) => r.providerRefundId).sort()).toEqual(expectedIds)
            expect(rows.map((r) => r.status)).toEqual(rows.map(() => 'succeeded'))
            expect(rows.map((r) => r.actor)).toEqual(rows.map(() => 'system:provider'))
            const money = await storedMoney(raw, order.orderId)
            const sumDelivered = [...delivered].reduce((sum, i) => sum + amounts[i]!, 0)
            expect(money.refundedMinor).toBe(sumDelivered)
            expect(money.refundedMinor).toBe(sumOf(rows, 'succeeded'))
            expect(money.refundedMinor).toBeLessThanOrEqual(captured)
            expect(money.status, 'a refund writes no status').toBe(statusBefore)
            const read = await adminRead(order.orderNumber)
            expect(read.payment?.state).toBe(
              paymentState({
                capturedMinor: money.capturedMinor,
                refundedMinor: money.refundedMinor,
              }),
            )
          }

          const rows = await storedRefunds(raw, order.orderId)
          const history = await refundHistory(raw, order.orderId)
          expect(history).toHaveLength(amounts.length)
          for (const h of history) {
            expect(h.fromStatus).toBe(statusBefore)
            expect(h.toStatus).toBe(statusBefore)
          }
          const paymentEvents = await refundEvents(raw, 'payment.refunded.v1', order.orderId)
          expect(paymentEvents.map((e) => e.refundId).sort()).toEqual(rows.map((r) => r.id).sort())
          const full = await refundEvents(raw, 'order.refunded.v1', order.orderId)
          const partial = await refundEvents(raw, 'order.partially_refunded.v1', order.orderId)
          expect(full.length + partial.length).toBe(amounts.length)
          expect(full).toHaveLength(reachCapture ? 1 : 0)
          if (reachCapture) {
            const lastRow = rows.find((r) => r.providerRefundId === ids[lastNew]!)!
            expect(full[0]!.refundId, 'the refund that reached the capture').toBe(lastRow.id)
          }
          const total = amounts.reduce((sum, a) => sum + a, 0)
          expect(await customerSpend(raw, customerId)).toBe(spentBefore - total)

          await k.app.relay.drain()
          const at = await instantAfter()
          const read = dataOf(
            await session.send<Record<string, unknown>>(
              'GET',
              `/api/admin/orders/${order.orderNumber}`,
            ),
            'admin read',
          )
          const asOf = dataOf(await readAsOf(session, 'order', order.orderNumber, at), '?at=')
          expect(asOf.record).toEqual(orderView(read))
        }),
        { numRuns: runs, endOnFailure: true },
      )
    }, 240_000)

    /** An admin refund end to end, the webhook arriving at `arrive`; asserts one of everything. */
    async function adminRefundAndWebhook(
      arrive: (order: PaidOrder, refundId: () => Promise<string>) => Promise<WebhookAnswer>,
    ) {
      const customerId = await registeredCustomer(k)
      const order = await paidOrder(k, { customerId })
      const spentBefore = await customerSpend(raw, customerId)
      const amount = 2_500
      const answered = await refundAsAdmin(order, amount)
      expect(answered.status, JSON.stringify(answered.body)).toBe(200)
      expect(answered.body.data!.refund.status).toBe('succeeded')
      const webhook = await arrive(order, async () => answered.body.data!.refund.id)
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('succeeded')
      expect(await refundHistory(raw, order.orderId)).toHaveLength(1)
      expect(await allRefundEvents(raw, order.orderId)).toHaveLength(2)
      expect((await storedMoney(raw, order.orderId)).refundedMinor).toBe(amount)
      expect(await customerSpend(raw, customerId)).toBe(spentBefore - amount)
      return webhook
    }

    // Defect: a webhook after the store's own settle inserts a second row beside it.
    it(`AC-5: a webhook after the local settle changes nothing: one row, one history row, one set of events, stats once, refundedMinor once, and the delivery answers reconciled with nothing to do (${dialect})`, async () => {
      const webhook = await adminRefundAndWebhook((order) =>
        deliver(served.baseUrl, refundedDelivery(order.intentId)),
      )
      expect(webhook.data).toEqual({ reconciled: true, recorded: 0, settled: 0, failed: 0 })
    })

    // Defect: the row is settled twice over, its effects run by both the webhook and the local write.
    it(`AC-5: a webhook delivered during the provider call settles the row once: one row, one history row, one set of events, stats once, and the request answers succeeded (${dialect})`, async () => {
      let webhook: WebhookAnswer | undefined
      payments.refund = (async (...args: unknown[]) => {
        const answer = await stubRefund(...args)
        const intentId = args[0] as string
        webhook = await deliver(served.baseUrl, refundedDelivery(intentId))
        return answer
      }) as PaymentsAdapter['refund']
      try {
        await adminRefundAndWebhook(async () => webhook!)
      } finally {
        payments.refund = stubRefund as PaymentsAdapter['refund']
      }
      expect(webhook?.data).toEqual({ reconciled: true, recorded: 0, settled: 1, failed: 0 })
    })

    // Defect: `settle`'s boolean is ignored, so a row a webhook settled first gets the local write's effects as well.
    it(`AC-5: a row another writer settled while the provider was answering is not counted by the local write: the request answers it succeeded, and the local write adds no history row, no event and no spend (${dialect})`, async () => {
      const customerId = await registeredCustomer(k)
      const order = await paidOrder(k, { customerId })
      const spentBefore = await customerSpend(raw, customerId)
      payments.refund = (async (...args: unknown[]) => {
        const answer = await stubRefund(...args)
        await unaudited(() =>
          k.store.transaction(async (tx) => {
            const [row] = await k.repos.orderRefund.listByOrder(tx, order.orderId)
            await k.repos.orderRefund.settle(tx, row!.id, {
              status: 'succeeded',
              providerRefundId: answer.refundId,
            })
          }),
        )
        return answer
      }) as PaymentsAdapter['refund']
      try {
        const answered = await refundAsAdmin(order, 1_000)
        expect(answered.status, JSON.stringify(answered.body)).toBe(200)
        expect(answered.body.data!.refund.status).toBe('succeeded')
      } finally {
        payments.refund = stubRefund as PaymentsAdapter['refund']
      }
      expect(await refundHistory(raw, order.orderId)).toHaveLength(0)
      expect(await allRefundEvents(raw, order.orderId)).toHaveLength(0)
      expect(await customerSpend(raw, customerId)).toBe(spentBefore)
    })

    // Defect: a row matched only by its provider id is missed, so a second row is inserted beside it.
    it(`AC-5: a row whose provider id alone the webhook's list names is settled by it, and no second row is made (${dialect})`, async () => {
      const order = await paidOrder(k)
      const providerId = `re_${randomUUID()}`
      const amount = 900
      payments.refund = (async (paymentId: string, amountMinor: number, reason: string) => ({
        refundId: providerId,
        paymentId,
        amountMinor,
        currency: 'GBP',
        reason,
        status: 'pending',
      })) as unknown as PaymentsAdapter['refund']
      let answered
      try {
        answered = await refundAsAdmin(order, amount)
      } finally {
        payments.refund = stubRefund as PaymentsAdapter['refund']
      }
      expect(answered.body.data!.refund.status).toBe('pending')
      const listing = answerListWith(payments, (paymentId) => [
        listed(paymentId, {
          refundId: providerId,
          amountMinor: amount,
          status: 'succeeded',
          idempotencyKey: null,
        }),
      ])
      try {
        const webhook = await deliver(served.baseUrl, refundedDelivery(order.intentId))
        expect(webhook.status).toBe(200)
        const rows = await storedRefunds(raw, order.orderId)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.status).toBe('succeeded')
        expect(rows[0]!.providerRefundId).toBe(providerId)
      } finally {
        listing.restore()
      }
    })

    interface PendingCase {
      name: string
      providerRefundId: string | null
      age: number
      list: (row: { id: string; amountMinor: number }, intent: string) => ListedRefund[]
      status: 'succeeded' | 'failed' | 'pending'
      storedProviderId: string | null
      effects: number
      logsError?: boolean
      /** A no-op case says nothing unless the pass ran: a second row, listed succeeded, must settle beside it. */
      witness?: boolean
    }

    const REPLY_ID = 're_replied'
    const CASES: PendingCase[] = [
      {
        name: 'listed succeeded by key → succeeded, the provider id stored, effects once, actor still the original admin',
        providerRefundId: null,
        age: 2 * HOUR,
        list: (row, intent) => [
          listed(intent, {
            refundId: REPLY_ID,
            amountMinor: row.amountMinor,
            status: 'succeeded',
            idempotencyKey: row.id,
          }),
        ],
        status: 'succeeded',
        storedProviderId: REPLY_ID,
        effects: 1,
      },
      {
        name: 'listed failed by key → failed, the amount refundable again, no effects',
        providerRefundId: null,
        age: 2 * HOUR,
        list: (row, intent) => [
          listed(intent, {
            refundId: REPLY_ID,
            amountMinor: row.amountMinor,
            status: 'failed',
            idempotencyKey: row.id,
          }),
        ],
        status: 'failed',
        storedProviderId: REPLY_ID,
        effects: 0,
      },
      {
        name: 'listed pending by key → stays pending with the provider id, no effects',
        providerRefundId: null,
        age: 2 * HOUR,
        list: (row, intent) => [
          listed(intent, {
            refundId: REPLY_ID,
            amountMinor: row.amountMinor,
            status: 'pending',
            idempotencyKey: row.id,
          }),
        ],
        status: 'pending',
        storedProviderId: REPLY_ID,
        effects: 0,
      },
      {
        name: 'listed with another amount → stays pending, an error logged, no effects',
        providerRefundId: null,
        age: 2 * HOUR,
        list: (row, intent) => [
          listed(intent, {
            refundId: REPLY_ID,
            amountMinor: row.amountMinor + 1,
            status: 'succeeded',
            idempotencyKey: row.id,
          }),
        ],
        status: 'pending',
        storedProviderId: null,
        effects: 0,
        logsError: true,
      },
      {
        name: 'not listed and older than an hour with no provider id → failed, no effects',
        providerRefundId: null,
        age: 2 * HOUR,
        list: () => [],
        status: 'failed',
        storedProviderId: null,
        effects: 0,
      },
      {
        name: 'not listed and younger than an hour → pending',
        providerRefundId: null,
        age: 10 * 60_000,
        list: () => [],
        status: 'pending',
        storedProviderId: null,
        effects: 0,
        witness: true,
      },
      {
        name: 'not listed with a provider id, whatever its age → pending',
        providerRefundId: 're_held',
        age: 3 * HOUR,
        list: () => [],
        status: 'pending',
        storedProviderId: 're_held',
        effects: 0,
        witness: true,
      },
    ]

    for (const c of CASES) {
      // Defect: a pending row has no exit, an unknown row is counted as refunded, or a settled row is rewritten.
      it(`AC-9: a pending row ${c.name} (${dialect})`, async () => {
        const order = await paidOrder(k)
        const rowId = randomUUID()
        const amountMinor = 1_500
        const actor = `admin:${randomUUID()}`
        await insertRefund(k, {
          id: rowId,
          orderId: order.orderId,
          amountMinor,
          status: 'pending',
          providerRefundId: c.providerRefundId,
          actor,
          createdAt: new Date(Date.now() - c.age),
        })
        const witnessId = randomUUID()
        if (c.witness === true) {
          await insertRefund(k, {
            id: witnessId,
            orderId: order.orderId,
            amountMinor: 400,
            status: 'pending',
            createdAt: new Date(Date.now() - c.age),
          })
        }
        const before = logs.calls.length
        const listing = answerListWith(payments, (paymentId) => [
          ...c.list({ id: rowId, amountMinor }, paymentId),
          ...(c.witness === true
            ? [
                listed(paymentId, {
                  refundId: 're_witness',
                  amountMinor: 400,
                  status: 'succeeded',
                  idempotencyKey: witnessId,
                }),
              ]
            : []),
        ])
        try {
          await reconcileOrder(k, order.orderId)
        } finally {
          listing.restore()
        }
        const rows = await storedRefunds(raw, order.orderId)
        const row = rows.find((r) => r.id === rowId)!
        expect(row.status).toBe(c.status)
        expect(row.providerRefundId).toBe(c.storedProviderId)
        if (c.witness === true) {
          expect(
            rows.find((r) => r.id === witnessId)!.status,
            'the pass settled the row it was given, beside this one',
          ).toBe('succeeded')
        }
        const effects = c.effects + (c.witness === true ? 1 : 0)
        const history = await refundHistory(raw, order.orderId)
        expect(history).toHaveLength(effects)
        expect(await allRefundEvents(raw, order.orderId)).toHaveLength(effects * 2)
        if (c.effects === 1) expect(history[0]!.actor).toBe(actor)
        const money = await storedMoney(raw, order.orderId)
        expect(money.refundedMinor).toBe(sumOf(rows, 'succeeded'))
        const read = await adminRead(order.orderNumber)
        expect(read.payment?.refundableMinor).toBe(
          order.totalMinor - sumOf(rows, 'succeeded') - sumOf(rows, 'pending'),
        )
        if (c.logsError === true) {
          const logged = logs.calls
            .slice(before)
            .filter((call) => call.level === 'error')
            .map((call) => JSON.stringify(call.obj))
          expect(logged.join(' ')).toContain(rowId)
        }
      })
    }

    // Defect: an outage reads as "the provider has no such refund" and fails a row that may have moved money.
    it(`AC-9: a list call that throws leaves a pending row unchanged and surfaces as a typed lookup failure (${dialect})`, async () => {
      const order = await paidOrder(k)
      const rowId = randomUUID()
      await insertRefund(k, {
        id: rowId,
        orderId: order.orderId,
        amountMinor: 1_500,
        status: 'pending',
        createdAt: new Date(Date.now() - 2 * HOUR),
      })
      const listing = answerListWith(payments, async () => {
        throw new PaymentError('intent_failed', 'the provider is down')
      })
      try {
        const thrown = await reconcileOrder(k, order.orderId).catch((err: unknown) => err)
        expect((thrown as { code?: string } | null)?.code).toBe('payment.refund_lookup_failed')
      } finally {
        listing.restore()
      }
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => r.status)).toEqual(['pending'])
    })

    const generatedRows = fc.array(
      fc.record({
        status: fc.constantFrom<'pending' | 'succeeded' | 'failed'>(
          'pending',
          'succeeded',
          'failed',
        ),
        amountMinor: fc.integer({ min: 100, max: 800 }),
        listing: fc.constantFrom('none', 'same', 'other', 'mismatch'),
        age: fc.constantFrom(10 * 60_000, 2 * HOUR),
        withProviderId: fc.boolean(),
      }),
      { minLength: 1, maxLength: 4 },
    )

    // Defect: a settled row is rewritten, an unknown row is counted, or the pass moves money.
    it(`AC-9: property: over generated rows and lists, a non-pending row never changes, refundedMinor = Σ succeeded after each pass, and reconciliation never refunds (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(generatedRows, async (generated) => {
          const order = await paidOrder(k)
          const witnessId = randomUUID()
          const rows = generated.map((g) => ({ ...g, id: randomUUID() }))
          for (const r of rows) {
            await insertRefund(k, {
              id: r.id,
              orderId: order.orderId,
              amountMinor: r.amountMinor,
              status: r.status,
              providerRefundId: r.withProviderId ? `re_${r.id}` : null,
              createdAt: new Date(Date.now() - r.age),
            })
          }
          await insertRefund(k, {
            id: witnessId,
            orderId: order.orderId,
            amountMinor: 500,
            status: 'pending',
            createdAt: new Date(Date.now() - 2 * HOUR),
          })
          const list = (paymentId: string): ListedRefund[] => [
            ...rows.flatMap((r): ListedRefund[] => {
              if (r.listing === 'none') return []
              const status =
                r.listing === 'other'
                  ? r.status === 'succeeded'
                    ? ('failed' as const)
                    : ('succeeded' as const)
                  : r.status
              return [
                listed(paymentId, {
                  refundId: r.withProviderId ? `re_${r.id}` : `re_new_${r.id}`,
                  amountMinor: r.listing === 'mismatch' ? r.amountMinor + 1 : r.amountMinor,
                  status,
                  idempotencyKey: r.id,
                }),
              ]
            }),
            listed(paymentId, {
              refundId: `re_${witnessId}`,
              amountMinor: 500,
              status: 'succeeded',
              idempotencyKey: witnessId,
            }),
          ]
          const before = new Map((await storedRefunds(raw, order.orderId)).map((r) => [r.id, r]))
          let refundCalls = 0
          payments.refund = (async (...args: unknown[]) => {
            refundCalls += 1
            return stubRefund(...args)
          }) as PaymentsAdapter['refund']
          const listing = answerListWith(payments, list)
          try {
            for (let pass = 0; pass < 2; pass += 1) {
              await reconcileOrder(k, order.orderId)
              const now = await storedRefunds(raw, order.orderId)
              for (const r of now) {
                const was = before.get(r.id)!
                if (was.status !== 'pending') expect(r).toEqual(was)
              }
              expect((await storedMoney(raw, order.orderId)).refundedMinor).toBe(
                sumOf(now, 'succeeded'),
              )
            }
          } finally {
            listing.restore()
            payments.refund = stubRefund as PaymentsAdapter['refund']
          }
          expect(refundCalls).toBe(0)
          const witness = (await storedRefunds(raw, order.orderId)).find((r) => r.id === witnessId)!
          expect(witness.status, 'every pass ran').toBe('succeeded')
        }),
        { numRuns: runs, endOnFailure: true },
      )
    }, 240_000)

    // Defect: an insert happens outside the lock, so two passes both record one provider refund.
    it(`AC-12: property: k in 1..4 concurrent reconcilePayment for one dashboard refund make one row, one set of events and one refundedMinor (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (concurrency) => {
          const order = await paidOrder(k)
          const providerId = `re_${randomUUID()}`
          const amount = 2_000
          const listing = answerListWith(payments, (paymentId) => [
            listed(paymentId, { refundId: providerId, amountMinor: amount, status: 'succeeded' }),
          ])
          try {
            await Promise.all(
              Array.from({ length: concurrency }, () => reconcilePayment(k, order.intentId)),
            )
          } finally {
            listing.restore()
          }
          const rows = await storedRefunds(raw, order.orderId)
          expect(rows).toHaveLength(1)
          expect(rows[0]!.providerRefundId).toBe(providerId)
          expect((await storedMoney(raw, order.orderId)).refundedMinor).toBe(amount)
          expect(await refundEvents(raw, 'payment.refunded.v1', order.orderId)).toHaveLength(1)
          expect(await refundHistory(raw, order.orderId)).toHaveLength(1)
        }),
        { numRuns: runs, endOnFailure: true },
      )
    }, 240_000)

    // Defect: the local settle and the webhook pass both count the refund.
    it(`AC-12: a webhook pass concurrent with a local refund's settle counts the refund once (${dialect})`, async () => {
      const order = await paidOrder(k)
      const amount = 1_250
      let webhook: Promise<WebhookAnswer> | undefined
      payments.refund = (async (...args: unknown[]) => {
        const answer = await stubRefund(...args)
        webhook = deliver(served.baseUrl, refundedDelivery(args[0] as string))
        return answer
      }) as PaymentsAdapter['refund']
      let answered
      try {
        answered = await refundAsAdmin(order, amount)
      } finally {
        payments.refund = stubRefund as PaymentsAdapter['refund']
      }
      expect(answered.status, JSON.stringify(answered.body)).toBe(200)
      const delivered = await webhook!
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('succeeded')
      expect((await storedMoney(raw, order.orderId)).refundedMinor).toBe(amount)
      expect(await refundHistory(raw, order.orderId)).toHaveLength(1)
      expect(await allRefundEvents(raw, order.orderId)).toHaveLength(2)
      expect(delivered.data?.['reconciled'], 'the delivery ran the pass').toBe(true)
    })
  })
}
