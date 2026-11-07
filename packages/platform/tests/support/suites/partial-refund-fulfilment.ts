import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_ORDER_DELIVERED,
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_ORDER_REFUNDED,
  EVT_ORDER_SHIPPED,
  orderMovesFrom,
  type OrderStatus,
} from '@nymbalhq/types'
import { REFUND_NOTE_PREFIX } from '../../../src/order-history-notes.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../kernel.js'
import { adminClient, adminOrder, storedMoney, type AdminClient } from '../money.js'
import { eventRows } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'
import type { ShopResponse } from '../shopper.js'

// A paid order refunded in part, then moved on through the admin's routes on one dialect: what each move answers,
// what it writes (status, history, shipment rows, events) and that the money columns keep saying what was refunded.
// Rows and events are read through a second connection.

const INVALID_TRANSITION = 'status.invalid_transition'
const FULFILMENT: readonly OrderStatus[] = ['processing', 'shipped', 'delivered']

type Move = 'process' | 'ship' | 'mark-delivered'
const MOVE_TO: Record<Move, OrderStatus> = {
  process: 'processing',
  ship: 'shipped',
  'mark-delivered': 'delivered',
}
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
  describe(`a partially refunded order ships and is delivered (${dialect})`, () => {
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

    it(`AC-3: property: a paid order refunded a (1 ≤ a < captured) at confirmed reads partially_refunded, then process, ship and mark-delivered each answer 200 and move it to processing, shipped and delivered, with one shipment row, one order.shipped and one order.delivered, and payment.state partially_refunded with refundedMinor = a after every step (${dialect})`, async () => {
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
            'partially_refunded',
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
            'partially_refunded',
            'processing',
            'shipped',
            'delivered',
          ])
        }),
        { numRuns: opts.runs },
      )
    }, 180_000)

    // ─── AC-4 ─────────────────────────────────────────────────────────────────────────────────────────────────

    /** A partial refund of a share of what is left, or a fulfilment move picked among the ones allowed then. */
    type Op = { kind: 'refund'; percent: number } | { kind: 'move'; pick: number }
    const refundOp = fc
      .integer({ min: 1, max: 40 })
      .map((percent): Op => ({ kind: 'refund', percent }))
    const moveOp = fc.nat({ max: 5 }).map((pick): Op => ({ kind: 'move', pick }))

    it(`AC-4: property: over partial refunds interleaved with the fulfilment moves orderMovesFrom allows, the first refund moves the order to partially_refunded and every later one keeps its status (never partially_refunded again once it moved on), each refund adds one history row with the refund note and one order.partially_refunded, refundedMinor = Σ refunds < captured, and a refund of the rest moves it to refunded (${dialect})`, async () => {
      const sequence = fc.record({
        priceMinor: fc.integer({ min: 400, max: 20_000 }),
        before: fc.array(moveOp, { maxLength: 3 }),
        after: fc.array(fc.oneof(refundOp, moveOp), { minLength: 1, maxLength: 7 }),
        first: refundOp,
      })
      await fc.assert(
        fc.asyncProperty(sequence, async ({ priceMinor, before, after, first }) => {
          const order = await paidOrder(priceMinor, 1)
          let status: OrderStatus = 'confirmed'
          let refundedAt: OrderStatus | null = null
          let sum = 0
          const trail: string[] = []

          for (const op of [...before, first, ...after]) {
            if (op.kind === 'move') {
              const allowed: OrderStatus[] = orderMovesFrom(status, refundedAt).filter(
                (s: OrderStatus) => FULFILMENT.includes(s),
              )
              if (allowed.length === 0) continue
              const to = allowed[op.pick % allowed.length]!
              trail.push(to)
              await moved(order.id, MOVE_OF[to]!)
              const now = await storedMoney(raw, order.id)
              expect([now.status, now.refundedMinor], trail.join(' → ')).toEqual([to, sum])
              status = to
              continue
            }
            const left = order.captured - sum
            const amount = Math.min(left - 1, Math.max(1, Math.floor((left * op.percent) / 100)))
            if (amount < 1) continue
            trail.push(`refund ${amount}`)
            const rowsBefore = await historyOf(order.id)
            const eventsBefore = await eventsOf(order.id, EVT_ORDER_PARTIALLY_REFUNDED)
            await refunded(order.id, amount)
            sum += amount
            const expected: OrderStatus = refundedAt === null ? 'partially_refunded' : status
            if (refundedAt === null) refundedAt = status
            status = expected

            const money = await storedMoney(raw, order.id)
            const rows = await historyOf(order.id)
            const context = trail.join(' → ')
            expect([money.status, money.refundedMinor, money.capturedMinor], context).toEqual([
              expected,
              sum,
              order.captured,
            ])
            expect(money.refundedMinor, context).toBeLessThan(money.capturedMinor)
            expect(rows.slice(0, rowsBefore.length), context).toEqual(rowsBefore)
            expect(rows.length, context).toBe(rowsBefore.length + 1)
            expect(rows.at(-1)!.to_status, context).toBe(expected)
            expect(rows.at(-1)!.note.startsWith(REFUND_NOTE_PREFIX), context).toBe(true)
            expect((await eventsOf(order.id, EVT_ORDER_PARTIALLY_REFUNDED)).length, context).toBe(
              eventsBefore.length + 1,
            )
            expect((await adminOrder(admin, order.orderNumber)).payment!.state, context).toBe(
              'partially_refunded',
            )
          }

          const history = (await historyOf(order.id)).map((r) => r.to_status)
          const firstIn = history.indexOf('partially_refunded')
          const movedOn = history.findIndex((s, i) => i > firstIn && s !== 'partially_refunded')
          if (movedOn >= 0) {
            expect(history.slice(movedOn), `never back: ${trail.join(' → ')}`).not.toContain(
              'partially_refunded',
            )
          }

          const heldBefore = status
          await refunded(order.id, order.captured - sum)
          const money = await storedMoney(raw, order.id)
          expect([money.status, money.refundedMinor], `refund the rest at ${heldBefore}`).toEqual([
            'refunded',
            order.captured,
          ])
          expect((await eventsOf(order.id, EVT_ORDER_REFUNDED)).length).toBe(1)
          expect((await historyOf(order.id)).at(-1)).toMatchObject({
            from_status: heldBefore,
            to_status: 'refunded',
          })
        }),
        { numRuns: opts.runs },
      )
    }, 300_000)

    // ─── AC-5 ─────────────────────────────────────────────────────────────────────────────────────────────────

    /** Each status an order is refunded at: the move it may make next, the moves it may not. */
    const CELLS: Array<{ at: OrderStatus; reach: Move[]; allowed: Move | null; refused: Move[] }> =
      [
        { at: 'confirmed', reach: [], allowed: 'process', refused: ['ship', 'mark-delivered'] },
        {
          at: 'processing',
          reach: ['process'],
          allowed: 'ship',
          refused: ['process', 'mark-delivered'],
        },
        {
          at: 'shipped',
          reach: ['process', 'ship'],
          allowed: 'mark-delivered',
          refused: ['ship', 'process'],
        },
        {
          at: 'delivered',
          reach: ['process', 'ship', 'mark-delivered'],
          allowed: null,
          refused: ['process', 'ship', 'mark-delivered'],
        },
      ]

    it(`AC-5: a partially refunded order moves on only as its refunded-at status would: refused moves (and cancel) answer 409 and write nothing, the one allowed move answers 200; at confirmed process, at processing ship, at shipped mark-delivered, at delivered none; never a 500, a second shipment row or a second order.delivered (${dialect})`, async () => {
      const outcomes: unknown[] = []
      const expected: unknown[] = []
      for (const cell of CELLS) {
        const order = await paidOrder()
        for (const m of cell.reach) await moved(order.id, m)
        await refunded(order.id, 700)
        const start = await written(order.id)
        expect(start.status, `refunded at ${cell.at}`).toBe('partially_refunded')

        for (const m of cell.refused) {
          const res = await move(order.id, m)
          outcomes.push([cell.at, m, ...answerOf(res), (await written(order.id)) as unknown])
          expected.push([cell.at, m, 409, INVALID_TRANSITION, start])
        }
        const cancelled = await cancel(order.id)
        outcomes.push([cell.at, 'cancel', ...answerOf(cancelled), await written(order.id)])
        expected.push([cell.at, 'cancel', 409, 'order.paid', start])

        if (cell.allowed !== null) {
          const res = await move(order.id, cell.allowed)
          const after = await written(order.id)
          outcomes.push([
            cell.at,
            cell.allowed,
            ...answerOf(res),
            after.status,
            after.refundedMinor,
          ])
          expected.push([cell.at, cell.allowed, 200, null, MOVE_TO[cell.allowed], 700])
        }
        const end = await written(order.id)
        outcomes.push([
          cell.at,
          'shipments, deliveries',
          end.shipments,
          (await eventsOf(order.id, EVT_ORDER_DELIVERED)).length,
        ])
        const shipsBy = cell.reach.includes('ship') || cell.allowed === 'ship' ? 1 : 0
        const deliversBy =
          cell.reach.includes('mark-delivered') || cell.allowed === 'mark-delivered'
        expected.push([cell.at, 'shipments, deliveries', shipsBy, deliversBy ? 1 : 0])
      }
      expect(outcomes).toEqual(expected)
    }, 120_000)
  })
}
