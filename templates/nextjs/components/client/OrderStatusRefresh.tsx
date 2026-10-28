'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { OrderStatus } from '@nymbalhq/types'
import { getNymbalClient } from '@/lib/client'

// A pending order's page asks the API again for a while: once the payment lands (a Stripe webhook), the page is
// rendered afresh with the order's new state.
const POLL_EVERY_MS = 1_000
const POLL_FOR_MS = 10_000

export function OrderStatusRefresh({
  orderNumber,
  orderKey,
  status,
}: {
  orderNumber: string
  /** The page's `?key=`: the API answers a guest's order to its key only. */
  orderKey?: string | undefined
  status: OrderStatus
}) {
  const router = useRouter()

  useEffect(() => {
    if (status !== 'pending') return
    const until = Date.now() + POLL_FOR_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const poll = async () => {
      try {
        const order = await getNymbalClient().customer.orders.get(
          orderNumber,
          orderKey ? { key: orderKey } : {},
        )
        if (stopped) return
        if (order.status !== status) {
          router.refresh()
          return
        }
      } catch {
        // A failed read is asked again on the next tick, within the window.
      }
      if (!stopped && Date.now() < until) timer = setTimeout(poll, POLL_EVERY_MS)
    }
    timer = setTimeout(poll, POLL_EVERY_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [orderNumber, orderKey, status, router])

  return null
}
