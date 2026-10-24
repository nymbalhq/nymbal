import {
  paymentState,
  type CustomerSnapshot,
  type Order,
  type OrderHistoryEntry,
  type OrderPayment,
  type ProductSnapshot,
  type Variant,
} from '@nymbalhq/types'

// The as-of views: each admin detail read less the fields no event carries, so a fold of the log can produce it. A
// field leaves a view only by a spec change, never because the fold cannot produce it.

/** `GET /api/admin/orders/:orderNumber`'s data. */
export type AdminOrderRead = Order & { payment: OrderPayment; history?: OrderHistoryEntry[] }

/** `GET /api/admin/customers/:id`'s data, of which only the customer is read. */
export interface AdminCustomerRead {
  customer: CustomerSnapshot
}

/** The admin order read without its notes, metadata, capture details, status history and refund rows. */
export type OrderAsOf = Omit<
  Order,
  'notes' | 'metadata' | 'updatedAt' | 'capturedAt' | 'captureMethod'
> & {
  payment: Omit<OrderPayment, 'refunds' | 'refundableMinor'>
}

/** A product snapshot without its variants' `updatedAt` (a stock move changes it with no event); categories sorted. */
export type ProductAsOf = Omit<ProductSnapshot, 'variants'> & {
  variants: Array<Omit<Variant, 'updatedAt'>>
}

export type CustomerAsOf = CustomerSnapshot

/** The order as it was placed, as the view: its payment derived from its amounts. */
export function orderViewOf(order: Order): OrderAsOf {
  const {
    notes: _notes,
    metadata: _metadata,
    updatedAt: _updatedAt,
    capturedAt: _capturedAt,
    captureMethod: _captureMethod,
    ...rest
  } = order as Order & { payment?: unknown; history?: unknown }
  const { payment: _payment, history: _history, ...view } = rest
  return {
    ...view,
    payment: {
      state: paymentState(order),
      capturedMinor: order.capturedMinor,
      refundedMinor: order.refundedMinor,
      currency: order.currency,
    },
  }
}

export function toOrderAsOf(read: AdminOrderRead): OrderAsOf {
  const view = orderViewOf(read)
  const { refunds: _refunds, refundableMinor: _refundable, ...payment } = read.payment
  return { ...view, payment }
}

export function toProductAsOf(snapshot: ProductSnapshot): ProductAsOf {
  return {
    ...snapshot,
    variants: snapshot.variants.map(({ updatedAt: _updatedAt, ...variant }) => variant),
    // A set: product.created keeps the order it was sent in, a read the repository's.
    categoryIds: [...snapshot.categoryIds].sort(),
  }
}

/** The customer row as the log keeps it: never its password hash, roles, metadata or stats. */
export function toCustomerSnapshot(customer: CustomerSnapshot): CustomerSnapshot {
  return {
    id: customer.id,
    email: customer.email,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    addresses: customer.addresses,
    createdAt: customer.createdAt,
  }
}

export function toCustomerAsOf(read: AdminCustomerRead): CustomerAsOf {
  return toCustomerSnapshot(read.customer)
}
