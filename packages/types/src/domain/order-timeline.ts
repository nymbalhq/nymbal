import type { Address, Order } from './order.js'

/** The lifecycle events an order's timeline shows, each one from an `order_history` row. */
export const ORDER_TIMELINE_KINDS = [
  'placed',
  'paid',
  'shipped',
  'delivered',
  'cancelled',
  'partially_refunded',
  'refunded',
] as const

export type OrderTimelineKind = (typeof ORDER_TIMELINE_KINDS)[number]

export interface OrderTimelineEntry {
  kind: OrderTimelineKind
  /** ISO 8601, UTC. */
  at: string
}

/** A shipping address as an order's key holder reads it: no phone, no company. */
export type ShopperAddress = Omit<Address, 'phone' | 'company'>

/** What only the order's signed-in owner reads, or the store's own records, beside what its key holder reads. */
type OwnerOrStoreField =
  | 'id'
  | 'email'
  | 'billingAddress'
  | 'customerId'
  | 'sequence'
  | 'capturedMinor'
  | 'capturedAt'
  | 'refundedMinor'
  | 'captureMethod'
  | 'notes'
  | 'metadata'
  | 'paymentIntentId'
  | 'updatedAt'

/**
 * An order as a storefront reads it. A key holder reads the confirmation page's fields; its owner's session adds the
 * email, both full addresses and the order's id. Every other field is optional, so an adapter that returns a plain
 * `Order` still fits.
 */
export interface ShopperOrder
  extends
    Omit<Order, OwnerOrStoreField | 'shippingAddress'>,
    Partial<Pick<Order, OwnerOrStoreField>> {
  shippingAddress: ShopperAddress
  timeline?: OrderTimelineEntry[]
}
