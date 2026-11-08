import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { orderMovesFrom, type NymbalEvent, type Order, type OrderStatus } from '@nymbalhq/types'
import type { LoggedEvent } from '../repositories/event-log.js'
import { foldHistory } from './fold.js'
import type { OrderAsOf } from './views.js'

// AC-10: the order's history fold settles a refund as the refund service does. The first partial refund (nothing
// refunded before it) moves the folded status to partially_refunded; a later one leaves the status the order holds,
// so an order that moved on after a partial refund reads as it is at every instant.

const ORDER_ID = '0195f3a2-0000-7000-8000-000000000001'
const CREATED = new Date('2026-11-07T09:00:00.000Z')

function placed(totalMinor: number): Order {
  const address = {
    firstName: 'Ada',
    lastName: 'Buyer',
    addressLine1: '1 Main St',
    city: 'London',
    region: 'England',
    postalCode: 'E1 6AN',
    country: 'GB',
  }
  return {
    id: ORDER_ID,
    orderNumber: 'NYM-1001',
    sequence: 1000,
    customerId: null,
    status: 'pending',
    email: 'ada@fold.test',
    billingAddress: address,
    shippingAddress: address,
    lineItems: [],
    subtotalMinor: totalMinor,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor,
    currency: 'GBP',
    notes: '',
    metadata: {},
    paymentIntentId: null,
    capturedMinor: 0,
    capturedAt: null,
    refundedMinor: 0,
    captureMethod: null,
    source: 'storefront',
    createdAt: CREATED.toISOString(),
    updatedAt: CREATED.toISOString(),
  }
}

/** The log of one order, appended as the order service and refund service publish. */
function log() {
  const rows: LoggedEvent[] = []
  let refunds = 0
  const append = (type: string, payload: unknown) => {
    const seq = rows.length + 1
    const at = new Date(CREATED.getTime() + seq * 1000)
    rows.push({
      seq,
      event: {
        id: `evt-${seq}`,
        type,
        timestamp: at.toISOString(),
        source: 'nymbal',
        correlationId: `cor-${seq}`,
        payload,
        metadata: { storeId: 'store', environment: 'test', version: '1' },
      } as unknown as NymbalEvent<unknown>,
      deliveredAt: null,
      attempts: 0,
      deadAt: null,
      createdAt: at,
    })
  }
  const refund = (
    type: 'order.refunded.v1' | 'order.partially_refunded.v1',
    amountMinor: number,
  ) => {
    refunds += 1
    const refundId = `ref-${refunds}`
    const body = { orderId: ORDER_ID, refundId, amountMinor, currency: 'GBP', reason: '' }
    append(type, body)
    append('payment.refunded.v1', {
      paymentId: '',
      orderId: ORDER_ID,
      refundId,
      amountMinor,
      currency: 'GBP',
    })
  }
  return {
    rows,
    place: (totalMinor: number) => append('order.placed.v1', { order: placed(totalMinor) }),
    pay: (amountMinor: number) => append('order.paid.v1', { orderId: ORDER_ID, amountMinor }),
    move(from: OrderStatus, to: OrderStatus) {
      if (to === 'shipped') {
        append('order.shipped.v1', { orderId: ORDER_ID, trackingNumber: 'TRK-1', carrier: 'UPS' })
      } else if (to === 'delivered') append('order.delivered.v1', { orderId: ORDER_ID })
      else append('order.status_changed.v1', { orderId: ORDER_ID, from, to })
    },
    partial: (amountMinor: number) => refund('order.partially_refunded.v1', amountMinor),
    full: (amountMinor: number) => refund('order.refunded.v1', amountMinor),
  }
}

const folded = (rows: LoggedEvent[]): OrderAsOf => foldHistory('order', rows) as OrderAsOf

describe('AC-10: the history fold settles refunds as the record does', () => {
  it('AC-10: refunded in part at confirmed, processed and shipped, a later partial refund leaves the folded status shipped; the first one folded to partially_refunded', () => {
    const l = log()
    l.place(2500)
    l.pay(2500)
    l.partial(500)
    const first = folded(l.rows)
    l.move('partially_refunded', 'processing')
    l.move('processing', 'shipped')
    const shipped = folded(l.rows)
    l.partial(300)
    const later = folded(l.rows)

    expect(first.status).toBe('partially_refunded')
    expect(shipped.status).toBe('shipped')
    expect(later.status, 'a later partial refund keeps the status').toBe(shipped.status)
    expect(later.payment).toMatchObject({
      state: 'partially_refunded',
      refundedMinor: shipped.payment.refundedMinor + 300,
    })
  })

  type Op = { kind: 'refund'; percent: number } | { kind: 'move'; pick: number }
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.integer({ min: 1, max: 40 }).map((percent): Op => ({ kind: 'refund', percent })),
    fc.nat({ max: 5 }).map((pick): Op => ({ kind: 'move', pick })),
  )

  it('AC-10: property: over partial refunds interleaved with the fulfilment moves orderMovesFrom allows, each partial refund folds to partially_refunded when nothing was refunded before it and leaves the folded status otherwise, refundedMinor is the sum so far, and a refund of the rest folds to refunded', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 50_000 }),
        fc.array(op, { minLength: 1, maxLength: 12 }),
        (captured, ops) => {
          const l = log()
          l.place(captured)
          l.pay(captured)
          let status: OrderStatus = 'confirmed'
          let refundedAt: OrderStatus | null = null
          let sum = 0
          const seen: unknown[] = []
          const wanted: unknown[] = []
          for (const o of ops) {
            const before = folded(l.rows)
            if (o.kind === 'move') {
              const allowed: OrderStatus[] = orderMovesFrom(status, refundedAt).filter(
                (s: OrderStatus) => ['processing', 'shipped', 'delivered'].includes(s),
              )
              if (allowed.length === 0) continue
              const to = allowed[o.pick % allowed.length]!
              l.move(status, to)
              seen.push(['move', folded(l.rows).status])
              wanted.push(['move', to])
              status = to
              continue
            }
            const left = captured - sum
            const amount = Math.min(left - 1, Math.max(1, Math.floor((left * o.percent) / 100)))
            if (amount < 1) continue
            l.partial(amount)
            sum += amount
            const after = folded(l.rows)
            const expected =
              before.payment.refundedMinor === 0 ? 'partially_refunded' : before.status
            if (refundedAt === null) refundedAt = status
            status = expected
            seen.push(['refund', after.status, after.payment.refundedMinor, after.payment.state])
            wanted.push([
              'refund',
              expected,
              before.payment.refundedMinor + amount,
              'partially_refunded',
            ])
          }
          expect(seen).toEqual(wanted)
          l.full(captured - sum)
          const end = folded(l.rows)
          expect([end.status, end.payment.refundedMinor, end.payment.state]).toEqual([
            'refunded',
            captured,
            'refunded',
          ])
        },
      ),
      { numRuns: 300 },
    )
  })
})
