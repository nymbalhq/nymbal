import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isAuthenticated } from '@/lib/auth'
import { createSseClient } from '@/lib/sse'
import { createEventHandlers, useEventTicker } from '@/realtime/handlers'
import type { Order, InventoryRow } from '@/types'

interface RealtimeProviderProps {
  children: React.ReactNode
}

function getTickerLabel(type: string, data: unknown): string {
  switch (type) {
    case 'order.placed.v1': {
      const o = data as Order
      return `New order #${o.orderNumber}`
    }
    case 'order.paid.v1': {
      const o = data as Order
      return `Payment received #${o.orderNumber}`
    }
    case 'order.shipped.v1': {
      const o = data as Order
      return `Order shipped #${o.orderNumber}`
    }
    case 'order.delivered.v1': {
      const o = data as Order
      return `Order delivered #${o.orderNumber}`
    }
    case 'inventory.low_stock.v1': {
      const r = data as InventoryRow
      return `Low stock: ${r.productName}`
    }
    case 'inventory.out_of_stock.v1': {
      const r = data as InventoryRow
      return `Out of stock: ${r.productName}`
    }
    case 'payment.failed.v1':
      return 'Payment failed'
    default:
      return type.replace(/\./g, ' ').replace(/v\d+$/, '').trim()
  }
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  const queryClient = useQueryClient()
  const clientRef = useRef<ReturnType<typeof createSseClient> | null>(null)
  const pushEvent = useEventTicker((s) => s.pushEvent)

  useEffect(() => {
    if (!isAuthenticated()) return

    const handleEvent = createEventHandlers(queryClient)

    const sseClient = createSseClient((type, data) => {
      handleEvent(type, data)
      const label = getTickerLabel(type, data)
      pushEvent(type, label)
    })

    clientRef.current = sseClient
    sseClient.connect()

    return () => {
      sseClient.disconnect()
      clientRef.current = null
    }
  }, [queryClient, pushEvent])

  return <>{children}</>
}
