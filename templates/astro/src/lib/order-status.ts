import type { OrderStatus } from '@nymbalhq/types'

const PAID: ReadonlySet<OrderStatus> = new Set(['confirmed', 'processing', 'shipped', 'delivered'])

/** The order page's heading, from the order's real state: never "confirmed" before the payment is. */
export function orderHeading(status: OrderStatus): string {
  if (PAID.has(status)) return 'Order confirmed'
  if (status === 'pending') return 'Awaiting payment'
  return `Order ${status.replace(/_/g, ' ')}`
}

export function isPaid(status: OrderStatus): boolean {
  return PAID.has(status)
}
