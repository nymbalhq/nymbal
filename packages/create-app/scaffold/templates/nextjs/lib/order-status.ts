import type { OrderStatus, ShopperOrder } from '@nymbalhq/types'

type OrderView = Pick<ShopperOrder, 'status' | 'payment'>

const PAID: ReadonlySet<OrderStatus> = new Set(['confirmed', 'processing', 'shipped', 'delivered'])

const refunded = (order: OrderView): boolean => order.payment?.state === 'refunded'

/** The order page's heading, from the order's real state: never "confirmed" before the payment is. */
export function orderHeading(order: OrderView): string {
  if (refunded(order)) return 'Order refunded'
  if (PAID.has(order.status)) return 'Order confirmed'
  if (order.status === 'pending') return 'Awaiting payment'
  return `Order ${order.status}`
}

export function isPaid(order: OrderView): boolean {
  return PAID.has(order.status) && !refunded(order)
}

/** What the page says the order is when it does not thank the shopper for it. */
export function orderStanding(order: OrderView): string {
  return refunded(order) ? 'refunded' : order.status
}

/** The refund line under the status; null when nothing was refunded. */
export function refundLabel(order: OrderView): string | null {
  if (refunded(order)) return 'Refunded'
  return order.payment?.state === 'partially_refunded' ? 'Partially refunded' : null
}
