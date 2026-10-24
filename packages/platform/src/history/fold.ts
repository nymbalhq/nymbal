import {
  canTransitionOrder,
  paymentState,
  type CustomerSnapshot,
  type HistoryKind,
  type Order,
  type OrderStatus,
  type ProductSnapshot,
} from '@nymbalhq/types'
import type { LoggedEvent } from '../repositories/event-log.js'
import {
  orderViewOf,
  toCustomerSnapshot,
  toProductAsOf,
  type CustomerAsOf,
  type OrderAsOf,
  type ProductAsOf,
} from './views.js'

/** What a product's view becomes once its `product.deleted` is folded. */
export interface DeletedView {
  deleted: true
  deletedAt: string
}

export type HistoryView = OrderAsOf | ProductAsOf | CustomerAsOf

/** A fold's result: the view, the deleted marker, or null when no base event has been folded yet. */
export type Folded = HistoryView | DeletedView | null

type Payload = Record<string, unknown>

/** `product.updated.v1` → `product.updated`. */
export function eventName(type: string): string {
  return type.replace(/\.v\d+$/, '')
}

function payloadOf(row: LoggedEvent): Payload {
  const payload = row.event.payload
  return payload !== null && typeof payload === 'object' ? (payload as Payload) : {}
}

function objectAt(payload: Payload, key: string): Record<string, unknown> | null {
  const value = payload[key]
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

const BASE_EVENTS: Record<HistoryKind, { names: readonly string[]; snapshot: string }> = {
  product: { names: ['product.created', 'product.updated'], snapshot: 'product' },
  order: { names: ['order.placed'], snapshot: 'order' },
  customer: { names: ['customer.created', 'customer.updated'], snapshot: 'customer' },
}

/** A base event sets the whole view: it carries the record's snapshot. */
export function isBaseEvent(kind: HistoryKind, row: LoggedEvent): boolean {
  const base = BASE_EVENTS[kind]
  return (
    base.names.includes(eventName(row.event.type)) &&
    objectAt(payloadOf(row), base.snapshot) !== null
  )
}

export function isDeleted(view: Folded): view is DeletedView {
  return view !== null && (view as Partial<DeletedView>).deleted === true
}

function applyProduct(view: Folded, row: LoggedEvent): Folded {
  if (isDeleted(view)) return view
  const name = eventName(row.event.type)
  const payload = payloadOf(row)
  if (isBaseEvent('product', row)) return toProductAsOf(payload['product'] as ProductSnapshot)
  if (name === 'product.deleted') return { deleted: true, deletedAt: row.createdAt.toISOString() }
  if (view === null || name !== 'inventory.changed') return view
  const product = view as ProductAsOf
  const variantId = payload['variantId']
  const newQty = payload['newQty']
  if (typeof newQty !== 'number' || !product.variants.some((v) => v.id === variantId)) return view
  return {
    ...product,
    variants: product.variants.map((v) => (v.id === variantId ? { ...v, stock: newQty } : v)),
  }
}

/** A settled refund moves the status only where the transition table allows it, as settling does. */
function refundedStatus(status: OrderStatus, target: OrderStatus): OrderStatus {
  return status !== target && canTransitionOrder(status, target) ? target : status
}

/**
 * What an order's fold carries beside the view: the refunds an `order.refunded` or `order.partially_refunded` has
 * counted. A settled refund publishes `payment.refunded` beside one of those; a refund of a capture on a cancelled
 * order publishes `payment.refunded` alone, so only a refund no order event counted adds to `refundedMinor`.
 */
interface FoldContext {
  countedRefunds: Set<string>
}

function applyOrder(view: Folded, row: LoggedEvent, context: FoldContext): Folded {
  const name = eventName(row.event.type)
  const payload = payloadOf(row)
  if (isBaseEvent('order', row)) return orderViewOf(payload['order'] as Order)
  if (view === null || isDeleted(view)) return view
  const order = view as OrderAsOf
  let next: OrderAsOf
  switch (name) {
    case 'order.status_changed':
      next = { ...order, status: payload['to'] as OrderStatus }
      break
    case 'order.shipped':
      next = { ...order, status: 'shipped' }
      break
    case 'order.delivered':
      next = { ...order, status: 'delivered' }
      break
    case 'order.cancelled':
      next = { ...order, status: 'cancelled' }
      break
    case 'payment.intent_created':
      next = { ...order, paymentIntentId: payload['paymentId'] as string }
      break
    case 'payment.captured':
      next = { ...order, capturedMinor: payload['amountMinor'] as number }
      break
    case 'order.paid':
      next = {
        ...order,
        capturedMinor: payload['amountMinor'] as number,
        status: order.status === 'pending' ? 'confirmed' : order.status,
      }
      break
    case 'payment.refunded': {
      const refundId = payload['refundId'] as string
      if (context.countedRefunds.has(refundId)) return view
      context.countedRefunds.add(refundId)
      next = { ...order, refundedMinor: order.refundedMinor + (payload['amountMinor'] as number) }
      break
    }
    case 'order.refunded':
    case 'order.partially_refunded':
      context.countedRefunds.add(payload['refundId'] as string)
      next = {
        ...order,
        refundedMinor: order.refundedMinor + (payload['amountMinor'] as number),
        status: refundedStatus(
          order.status,
          name === 'order.refunded' ? 'refunded' : 'partially_refunded',
        ),
      }
      break
    default:
      return view
  }
  return {
    ...next,
    payment: {
      ...next.payment,
      state: paymentState(next),
      capturedMinor: next.capturedMinor,
      refundedMinor: next.refundedMinor,
    },
  }
}

function applyCustomer(view: Folded, row: LoggedEvent): Folded {
  if (!isBaseEvent('customer', row)) return view
  return toCustomerSnapshot(payloadOf(row)['customer'] as CustomerSnapshot)
}

/** A fold in progress: rows applied one at a time, in `seq` order, each returning the view so far. */
export interface Fold {
  apply(row: LoggedEvent): Folded
}

/** A fold of `kind` from nothing. Rows before a base event leave the view null. */
export function startFold(kind: HistoryKind): Fold {
  let view: Folded = null
  const context: FoldContext = { countedRefunds: new Set() }
  return {
    apply(row) {
      if (kind === 'order') view = applyOrder(view, row, context)
      else if (kind === 'product') view = applyProduct(view, row)
      else view = applyCustomer(view, row)
      return view
    },
  }
}

/**
 * The view a subject's events give, folded in `seq` order: a pure function of the rows. A product's events are its
 * own and those of the variants its snapshots name.
 */
export function foldHistory(kind: HistoryKind, events: readonly LoggedEvent[]): Folded {
  const fold = startFold(kind)
  let view: Folded = null
  for (const row of [...events].sort((a, b) => a.seq - b.seq)) view = fold.apply(row)
  return view
}
