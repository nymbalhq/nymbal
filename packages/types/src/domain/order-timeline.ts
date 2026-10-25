import type { Order } from './order.js'

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

/** An order as a storefront reads it; `timeline` is optional so an adapter that returns a plain `Order` still fits. */
export interface ShopperOrder extends Order {
  timeline?: OrderTimelineEntry[]
}
