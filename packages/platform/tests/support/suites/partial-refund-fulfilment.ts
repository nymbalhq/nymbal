import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_ORDER_DELIVERED,
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_ORDER_REFUNDED,
  EVT_ORDER_SHIPPED,
  paymentState,
  type OrderStatus,
  type PaymentState,
} from '@nymbalhq/types'
import { REFUND_NOTE_PREFIX } from '../../../src/order-history-notes.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, checkoutOf, createKernel, seedVariant, type Kernel } from '../kernel.js'
import {
  adminClient,
  adminOrder,
  storedMoney,
  storedRefunds,
  type AdminClient,
} from '../money.js'
import { eventRows } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'
import type { ShopResponse } from '../shopper.js'

// A paid order refunded in part or in full and moved on through the admin's routes on one dialect: a refund changes the
// money and never the status, each move answers from the fulfilment table and a full refund alone closes further work.
// Rows and events are read through a second connection; which moves are open comes from the table pinned below, not
// from the kernel's helper.

const INVALID_TRANSITION = 'status.invalid_transition'
const FULFILMENT: readonly OrderStatus[] = ['processing', 'shipped', 'delivered']

const TABLE: Record<string, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
}

/** The fulfilment moves open to an order: the table's row, less processing and shipped once refunded in full. */
const openMoves = (status: OrderStatus, payment: PaymentState): OrderStatus[] =>
  TABLE[status]!.filter(
    (m) => FULFILMENT.includes(m) && !(payment === 'refunded' && m !== 'delivered'),
  )

type Move = 'process' | 'ship' | 'mark-delivered'
const MOVE_OF: Partial<Record<OrderStatus, Move>> = {
  processing: 'process',
  shipped: 'ship',
  delivered: 'mark-delivered',
}

interface HistoryRow {
  from_status: string | null
  to_status: string
  note: string
}

/** What a refused command must leave as it was. */
interface Written {
  status: string
  capturedMinor: number
  refundedMinor: number
  history: HistoryRow[]
  shipments: number
  events: string[]
}

export function partialRefundFulfilmentSuite(
  dialect: Kernel['dialect'],
  /** A fresh, empty database: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
  opts: { runs: number },
): void {
  describe(`refunds leave the order's status alone (${dialect})`, () => {
    let db: { target: string; drop(): Promise<void> }
    let served: ServedKernel
    let k: Kernel
    let raw: RawReader
    let admin: AdminClient

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
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
      await db?.drop()
    })

    const answerOf = (res: ShopResponse<unknown>) => [res.status, res.body.error?.code ?? null]

    /** A checkout the stub pays inline: confirmed, captured = its total. */
    async function paidOrder(priceMinor = 2500, qty = 1) {
      const seeded = await seedVariant(k, qty + 1, { priceMinor })
      const placed = await checkoutOf(k, seeded, qty, `buyer-${randomUUID()}@fulfil.test`)
      expect(placed.orderStatus).toBe('confirmed')
      return { id: placed.orderId, orderNumber: placed.orderNumber, captured: placed.totalMinor }
    }

    const refund = (orderId: string, amountMinor: number) =>
      admin.call<unknown>('POST', `/api/admin/orders/${orderId}/refund`, {
        amountMinor,
        reason: 'damaged in transit',
      })

    const move = (orderId: string, m: Move) =>
      admin.call<unknown>(
        'POST',
        `/api/admin/orders/${orderId}/${m}`,
        m === 'ship' ? { trackingNumber: `1Z${randomUUID().slice(0, 8)}`, carrier: 'UPS' } : {},
      )

    const cancel = (orderId: string) =>
      admin.call<unknown>('POST', `/api/admin/orders/${orderId}/cancel`, { reason: 'changed mind' })

    async function historyOf(orderId: string): Promise<HistoryRow[]> {
      return raw.rows<HistoryRow>(
        'SELECT from_status, to_status, note FROM order_history WHERE order_id = ? ORDER BY timestamp, id',
        [orderId],
      )
    }

    async function shipmentsOf(orderId: string): Promise<number> {
      return raw.count('order_shipments', 'order_id = ?', [orderId])
    }

    /** The order's events of `type` (all its events when no type), by id, in seq order. */
    async function eventsOf(orderId: string, type?: string): Promise<string[]> {
      const rows =
        type === undefined ? await eventRows(raw) : await eventRows(raw, 'type = ?', [type])
      return rows
        .filter((r) => {
          const p = r.envelope.payload as { orderId?: unknown; order?: { id?: unknown } }
          return p.orderId === orderId || p.order?.id === orderId
        })
        .map((r) => `${r.type}:${r.id}`)
    }

    async function written(orderId: string): Promise<Written> {
      const money = await storedMoney(raw, orderId)
      return {
        status: money.status,
        capturedMinor: money.capturedMinor,
        refundedMinor: money.refundedMinor,
        history: await historyOf(orderId),
        shipments: await shipmentsOf(orderId),
        events: await eventsOf(orderId),
      }
    }

    async function moved(orderId: string, m: Move): Promise<void> {
      const res = await move(orderId, m)
      expect(answerOf(res), `${m}: ${JSON.stringify(res.body)}`).toEqual([200, null])
    }

    async function refunded(orderId: string, amountMinor: number): Promise<void> {
      const res = await refund(orderId, amountMinor)
      expect(answerOf(res), `refund ${amountMinor}: ${JSON.stringify(res.body)}`).toEqual([
        200,
        null,
      ])
    }

    // ─── AC-3 ─────────────────────────────────────────────────────────────────────────────────────────────────

    /** A partial refund of a share of what is left, a refund of all of it, or a move picked among those open then. */
    type Op =
      | { kind: 'partial'; percent: number }
      | { kind: 'final' }
      | { kind: 'move'; pick: number }
    const partialOp = fc
      .integer({ min: 1, max: 40 })
      .map((percent): Op => ({ kind: 'partial', percent }))
    const finalOp = fc.constant<Op>({ kind: 'final' })
    const moveOp = fc.nat({ max: 5 }).map((pick): Op => ({ kind: 'move', pick }))
    const anyOp = fc.oneof(
      { weight: 4, arbitrary: partialOp },
      { weight: 1, arbitrary: finalOp },
      { weight: 4, arbitrary: moveOp },
    )

    it(`AC-3: property: over partial and final refunds interleaved with the moves open at each step, the status is exactly what the moves made it and a refund never changes it; each refund adds one history row from = to = the status with the refund note and one money event; payment.state is paymentState(amounts) after every step and refundedMinor = Σ refunds ≤ captured (${dialect})`, async () => {
      const sequence = fc.record({
        priceMinor: fc.integer({ min: 400, max: 20_000 }),
        ops: fc.array(anyOp, { minLength: 2, maxLength: 9 }),
        first: partialOp,
      })
      await fc.assert(
        fc.asyncProperty(sequence, async ({ priceMinor, ops, first }) => {
          const order = await paidOrder(priceMinor, 1)
          let status: OrderStatus = 'confirmed'
          let sum = 0
          const trail: string[] = []
          const statuses: string[] = []
          const walked: string[] = []

          for (const op of [first, ...ops]) {
            const amounts = { capturedMinor: order.captured, refundedMinor: sum }
            if (op.kind === 'move') {
              const open = openMoves(status, paymentState(amounts))
              if (open.length === 0) continue
              const to = open[op.pick % open.length]!
              trail.push(to)
              await moved(order.id, MOVE_OF[to]!)
              status = to
              const now = await storedMoney(raw, order.id)
              statuses.push(now.status)
              walked.push(to)
              expect([now.status, now.refundedMinor], trail.join(' → ')).toEqual([to, sum])
              continue
            }
            const left = order.captured - sum
            if (left === 0) continue
            const amount =
              op.kind === 'final'
                ? left
                : Math.min(left - 1, Math.max(1, Math.floor((left * op.percent) / 100)))
            if (amount < 1) continue
            trail.push(`refund ${amount}`)
            const rowsBefore = await historyOf(order.id)
            const evtType =
              amount === left ? EVT_ORDER_REFUNDED : EVT_ORDER_PARTIALLY_REFUNDED
            const eventsBefore = await eventsOf(order.id, evtType)
            await refunded(order.id, amount)
            sum += amount

            const context = trail.join(' → ')
            const stored = await storedMoney(raw, order.id)
            statuses.push(stored.status)
            walked.push(status)
            expect([stored.status, stored.refundedMinor, stored.capturedMinor], context).toEqual([
              status,
              sum,
              order.captured,
            ])
            expect(stored.refundedMinor, context).toBeLessThanOrEqual(stored.capturedMinor)
            const rows = await historyOf(order.id)
            expect(rows.slice(0, rowsBefore.length), context).toEqual(rowsBefore)
            expect(rows.length, context).toBe(rowsBefore.length + 1)
            expect([rows.at(-1)!.from_status, rows.at(-1)!.to_status], context).toEqual([
              status,
              status,
            ])
            expect(rows.at(-1)!.note.startsWith(REFUND_NOTE_PREFIX), context).toBe(true)
            expect((await eventsOf(order.id, evtType)).length, context).toBe(eventsBefore.length + 1)
            expect((await adminOrder(admin, order.orderNumber)).payment!.state, context).toBe(
              paymentState({ capturedMinor: order.captured, refundedMinor: sum }),
            )
          }
          expect(statuses, `the moves alone made the status: ${trail.join(' → ')}`).toEqual(walked)
        }),
        { numRuns: opts.runs },
      )
    }, 300_000)

    // ─── AC-4 ─────────────────────────────────────────────────────────────────────────────────────────────────

    it(`AC-4: property: a paid order refunded a (1 ≤ a < captured) at confirmed reads confirmed and partially_refunded; process, ship and mark-delivered each answer 200; one shipment row, one order.shipped and one order.delivered; payment.state and refundedMinor unchanged after every step (${dialect})`, async () => {
      const capture = fc.record({
        priceMinor: fc.integer({ min: 2, max: 20_000 }),
        qty: fc.integer({ min: 1, max: 3 }),
        share: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
      })
      await fc.assert(
        fc.asyncProperty(capture, async ({ priceMinor, qty, share }) => {
          const order = await paidOrder(priceMinor, qty)
          const a = 1 + Math.floor(share * (order.captured - 1))
          expect(a).toBeLessThan(order.captured)

          await refunded(order.id, a)
          const seen: Array<[string, string, number, number]> = []
          const look = async () => {
            const money = await storedMoney(raw, order.id)
            const read = await adminOrder(admin, order.orderNumber)
            seen.push([money.status, read.payment!.state, money.refundedMinor, money.capturedMinor])
          }
          await look()
          for (const m of ['process', 'ship', 'mark-delivered'] as const) {
            await moved(order.id, m)
            await look()
          }

          expect(seen.map(([status]) => status)).toEqual([
            'confirmed',
            'processing',
            'shipped',
            'delivered',
          ])
          expect(
            seen.map(([, state, refundedMinor, capturedMinor]) => [
              state,
              refundedMinor,
              capturedMinor,
            ]),
            'a move touches the money',
          ).toEqual(seen.map(() => ['partially_refunded', a, order.captured]))
          expect(await shipmentsOf(order.id)).toBe(1)
          expect((await eventsOf(order.id, EVT_ORDER_SHIPPED)).length).toBe(1)
          expect((await eventsOf(order.id, EVT_ORDER_DELIVERED)).length).toBe(1)
          expect((await historyOf(order.id)).map((r) => r.to_status).slice(-4)).toEqual([
            'confirmed',
            'processing',
            'shipped',
            'delivered',
          ])
        }),
        { numRuns: opts.runs },
      )
    }, 180_000)

    // ─── AC-5 ─────────────────────────────────────────────────────────────────────────────────────────────────

    const FORBIDDEN: Array<{ at: OrderStatus; reach: Move[]; refused: Move[] }> = [
      { at: 'shipped', reach: ['process', 'ship'], refused: ['process', 'ship'] },
      {
        at: 'delivered',
        reach: ['process', 'ship', 'mark-delivered'],
        refused: ['process', 'ship', 'mark-delivered'],
      },
    ]

    it(`AC-5: moves the table forbids stay forbidden whatever the money: after a partial refund at shipped, process and ship answer 409 ${INVALID_TRANSITION} with one shipment row; at delivered, process, ship and mark-delivered answer 409 with one order.delivered; cancel on a paid order, refunded or not, answers 409 order.paid; a refused command writes nothing and never answers 500 (${dialect})`, async () => {
      const outcomes: unknown[] = []
      const expected: unknown[] = []
      for (const cell of FORBIDDEN) {
        const order = await paidOrder()
        for (const m of cell.reach) await moved(order.id, m)
        await refunded(order.id, 700)
        const start = await written(order.id)
        outcomes.push([cell.at, 'after the refund', start.status, start.shipments])
        expected.push([cell.at, 'after the refund', cell.at, 1])

        for (const m of cell.refused) {
          const res = await move(order.id, m)
          outcomes.push([cell.at, m, ...answerOf(res), await written(order.id)])
          expected.push([cell.at, m, 409, INVALID_TRANSITION, start])
        }
        const cancelled = await cancel(order.id)
        outcomes.push([cell.at, 'cancel', ...answerOf(cancelled), await written(order.id)])
        expected.push([cell.at, 'cancel', 409, 'order.paid', start])

        const delivered = (await eventsOf(order.id, EVT_ORDER_DELIVERED)).length
        outcomes.push([cell.at, 'deliveries', delivered])
        expected.push([cell.at, 'deliveries', cell.at === 'delivered' ? 1 : 0])
      }

      const paid = await paidOrder()
      const partly = await paidOrder()
      await refunded(partly.id, 700)
      const whole = await paidOrder()
      await refunded(whole.id, whole.captured)
      for (const [name, order] of [
        ['unrefunded', paid],
        ['partly refunded', partly],
        ['fully refunded', whole],
      ] as const) {
        const before = await written(order.id)
        const res = await cancel(order.id)
        outcomes.push([name, 'cancel', ...answerOf(res), await written(order.id)])
        expected.push([name, 'cancel', 409, 'order.paid', before])
      }
      expect(outcomes).toEqual(expected)
    }, 120_000)

    // ─── AC-6 ─────────────────────────────────────────────────────────────────────────────────────────────────

    /** Refunds the whole capture at `at`, reached through the admin's routes. */
    async function refundedInFullAt(at: OrderStatus, reach: Move[]) {
      const order = await paidOrder()
      for (const m of reach) await moved(order.id, m)
      await refunded(order.id, order.captured)
      return { ...order, at }
    }

    /** An order captured at a status a refund cannot be taken at; the importer writes any status. */
    async function capturedAt(status: 'pending' | 'cancelled'): Promise<string> {
      const totalMinor = 2500
      const order = await k.services.order.importOrder({
        orderId: randomUUID(),
        orderNumber: `CAP-${randomUUID().slice(0, 8)}`,
        status,
        customerId: null,
        email: `captured-${randomUUID()}@fulfil.test`,
        billingAddress: address,
        shippingAddress: address,
        lineItems: [],
        subtotalMinor: totalMinor,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor,
        currency: 'GBP',
        createdAt: new Date(),
        capturedMinor: totalMinor,
        captureMethod: 'manual',
      })
      return order.id
    }

    it(`AC-6: a full refund leaves the status: at confirmed, process answers 409 order.refunded and ship ${INVALID_TRANSITION}; at processing, ship answers 409 order.refunded and process ${INVALID_TRANSITION}, writing nothing; at shipped mark-delivered answers 200 and it reads delivered; a refund on a pending or cancelled order with a capture answers 409 ${INVALID_TRANSITION} and writes nothing (${dialect})`, async () => {
      const outcomes: unknown[] = []
      const expected: unknown[] = []

      const CLOSED: Array<{ at: OrderStatus; reach: Move[]; answers: Array<[Move, string]> }> = [
        {
          at: 'confirmed',
          reach: [],
          answers: [
            ['process', 'order.refunded'],
            ['ship', INVALID_TRANSITION],
          ],
        },
        {
          at: 'processing',
          reach: ['process'],
          answers: [
            ['ship', 'order.refunded'],
            ['process', INVALID_TRANSITION],
          ],
        },
      ]
      for (const cell of CLOSED) {
        const order = await refundedInFullAt(cell.at, cell.reach)
        const start = await written(order.id)
        outcomes.push([cell.at, 'after the full refund', start.status, start.shipments])
        expected.push([cell.at, 'after the full refund', cell.at, 0])
        for (const [m, code] of cell.answers) {
          const res = await move(order.id, m)
          outcomes.push([cell.at, m, ...answerOf(res), await written(order.id)])
          expected.push([cell.at, m, 409, code, start])
        }
      }

      const shipped = await refundedInFullAt('shipped', ['process', 'ship'])
      outcomes.push(['shipped', (await storedMoney(raw, shipped.id)).status])
      expected.push(['shipped', 'shipped'])
      const deliver = await move(shipped.id, 'mark-delivered')
      outcomes.push(['deliver', ...answerOf(deliver), (await storedMoney(raw, shipped.id)).status])
      expected.push(['deliver', 200, null, 'delivered'])

      for (const status of ['pending', 'cancelled'] as const) {
        const id = await capturedAt(status)
        const before = { ...(await written(id)), refunds: await storedRefunds(raw, id) }
        const res = await refund(id, 100)
        outcomes.push([
          status,
          ...answerOf(res),
          { ...(await written(id)), refunds: await storedRefunds(raw, id) },
        ])
        expected.push([status, 409, INVALID_TRANSITION, before])
      }
      expect(outcomes).toEqual(expected)
    }, 120_000)
  })
}
