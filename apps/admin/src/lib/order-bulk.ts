import { fulfilmentMoves, paymentState } from '@nymbalhq/types'
import type { AdminOrder } from '@/types'

export type OrderBulkAction = 'cancel' | 'process'
export type OrderBulkSkipReason = 'paid' | 'refunded' | 'status'

export interface OrderBulkPlan {
  eligible: AdminOrder[]
  skipped: Array<{ order: AdminOrder; reason: OrderBulkSkipReason }>
}

/** Null when the action may run on the order. Reads stored amounts only: a row a realtime event placed has no `payment`. */
function skipReason(action: OrderBulkAction, order: AdminOrder): OrderBulkSkipReason | null {
  const moves = fulfilmentMoves(order.status, paymentState(order))
  if (action === 'cancel') {
    if (order.capturedMinor > 0) return 'paid'
    return moves.includes('cancelled') ? null : 'status'
  }
  if (moves.includes('processing')) return null
  return order.status === 'confirmed' ? 'refunded' : 'status'
}

export function planOrderBulk(
  action: OrderBulkAction,
  orders: readonly AdminOrder[],
): OrderBulkPlan {
  const plan: OrderBulkPlan = { eligible: [], skipped: [] }
  for (const order of orders) {
    const reason = skipReason(action, order)
    if (reason === null) plan.eligible.push(order)
    else plan.skipped.push({ order, reason })
  }
  return plan
}
