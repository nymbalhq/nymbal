import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { paymentState, type NymbalEvent, type Order, type OrderStatus, type PaymentState } from '@nymbalhq/types'
import type { LoggedEvent } from '../repositories/event-log.js'
import { foldHistory } from './fold.js'
import type { OrderAsOf } from './views.js'

// The order's history fold reads a refund as the kernel does: it changes the money and never the status, whatever
// status it came at; and an imported order's stored snapshot holding a money status folds to confirmed.

const ORDER_ID = '0195f3a2-0000-7000-8000-000000000001'
const CREATED = new Date('2026-11-07T09:00:00.000Z')

function placed(totalMinor: number, status: Order['status'] = 'pending'): Order {
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
    status,
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
    place: (totalMinor: number, status?: Order['status']) =>
      append('order.placed.v1', { order: placed(totalMinor, status) }),
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

/** The moves the status table allows, and the two a full refund closes. */
const TABLE: Record<string, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
}
const movesFrom = (status: OrderStatus, payment: PaymentState): OrderStatus[] =>
  TABLE[status]!.filter(
    (m) =>
      ['processing', 'shipped', 'delivered'].includes(m) &&
      !(payment === 'refunded' && (m === 'processing' || m === 'shipped')),
  )

describe('AC-9: the history fold reads refunds as money', () => {
  type Op = { kind: 'partial'; percent: number } | { kind: 'full' } | { kind: 'move'; pick: number }
  const op: fc.Arbitrary<Op> = fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 1, max: 40 }).map((percent): Op => ({ kind: 'partial', percent })) },
    { weight: 3, arbitrary: fc.nat({ max: 5 }).map((pick): Op => ({ kind: 'move', pick })) },
    { weight: 1, arbitrary: fc.constant<Op>({ kind: 'full' }) },
  )

  // Defect: the fold still moves the status on a refund (the table consulted), or drops the amount from refundedMinor.
  it('AC-9: property: over generated event logs, each refund event leaves the folded status as it was and moves refundedMinor by its amount, and each move folds to its own status with the money unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 50_000 }),
        fc.array(op, { minLength: 1, maxLength: 12 }),
        (captured, ops) => {
          const l = log()
          l.place(captured)
          l.pay(captured)
          let status: OrderStatus = 'confirmed'
          let sum = 0
          const seen: unknown[] = []
          const wanted: unknown[] = []
          for (const o of ops) {
            const amounts = { capturedMinor: captured, refundedMinor: sum }
            if (o.kind === 'move') {
              const allowed = movesFrom(status, paymentState(amounts))
              if (allowed.length === 0) continue
              const to = allowed[o.pick % allowed.length]!
              l.move(status, to)
              const after = folded(l.rows)
              seen.push(['move', after.status, after.payment.refundedMinor])
              wanted.push(['move', to, sum])
              status = to
              continue
            }
            const left = captured - sum
            if (left === 0) break
            const amount =
              o.kind === 'full'
                ? left
                : Math.min(left - 1, Math.max(1, Math.floor((left * o.percent) / 100)))
            if (amount < 1) continue
            const before = folded(l.rows)
            if (o.kind === 'full') l.full(amount)
            else l.partial(amount)
            sum += amount
            const after = folded(l.rows)
            seen.push(['refund', after.status, after.payment.refundedMinor, after.payment.state])
            wanted.push([
              'refund',
              before.status,
              before.payment.refundedMinor + amount,
              paymentState({ capturedMinor: captured, refundedMinor: sum }),
            ])
          }
          expect(seen).toEqual(wanted)
          expect(folded(l.rows).status).toBe(status)
        },
      ),
      { numRuns: 300 },
    )
  })

  // Defect: a legacy snapshot leaks a money status onto the as-of read, disagreeing with the migrated live read.
  it('AC-9: an order.placed snapshot with a stored refunded or partially_refunded status folds to confirmed, and the money events after it still count', () => {
    for (const legacy of ['refunded', 'partially_refunded'] as unknown as Order['status'][]) {
      const l = log()
      l.place(2500, legacy)
      const base = folded(l.rows)
      l.partial(100)
      const after = folded(l.rows)
      expect([base.status, after.status, after.payment.refundedMinor], String(legacy)).toEqual([
        'confirmed',
        'confirmed',
        base.payment.refundedMinor + 100,
      ])
    }
  })
})
