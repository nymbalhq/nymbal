import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import type { OrderBulkAction } from '@/lib/order-bulk'
import type { AdminOrder } from '@/types'

export interface OrderBulkOutcome {
  succeeded: string[]
  failed: Array<{ orderId: string; orderNumber: string; message: string }>
}

/**
 * Sends an action to each order in turn, every order its own command with its own idempotency key. A refusal does not
 * stop the rest, and the run always settles.
 */
export function useOrderBulkAction() {
  const queryClient = useQueryClient()
  // Set in the call itself: a second call in the same tick would still read React state as idle.
  const inFlight = useRef<Promise<OrderBulkOutcome> | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const send = useCallback(
    async (action: OrderBulkAction, orders: readonly AdminOrder[]) => {
      const outcome: OrderBulkOutcome = { succeeded: [], failed: [] }
      const total = orders.length
      setProgress({ done: 0, total })
      for (const [index, order] of orders.entries()) {
        try {
          await api.post(`/api/admin/orders/${order.id}/${action}`)
          outcome.succeeded.push(order.id)
        } catch (err) {
          outcome.failed.push({
            orderId: order.id,
            orderNumber: order.orderNumber,
            message: err instanceof ApiError ? err.message : 'The order could not be changed.',
          })
        }
        setProgress({ done: index + 1, total })
      }
      setProgress(null)
      for (const queryKey of [['orders', 'list'], ['orders', 'detail'], ['dashboard']]) {
        void queryClient.invalidateQueries({ queryKey })
      }
      return outcome
    },
    [queryClient],
  )

  const run = useCallback(
    (action: OrderBulkAction, orders: readonly AdminOrder[]) => {
      inFlight.current ??= send(action, orders).finally(() => {
        inFlight.current = null
      })
      return inFlight.current
    },
    [send],
  )

  return { run, running: progress !== null, progress }
}
