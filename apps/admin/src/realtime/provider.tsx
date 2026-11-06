import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isAuthenticated } from '@/lib/auth'
import { createSseClient } from '@/lib/sse'
import {
  createEventHandlers,
  resyncLiveQueries,
  useEventTicker,
  type DomainEvent,
} from '@/realtime/handlers'

interface RealtimeProviderProps {
  children: React.ReactNode
}

function getTickerLabel(event: DomainEvent): string {
  switch (event.type) {
    case 'order.placed.v1':
      return `New order #${event.payload.order.orderNumber}`
    case 'order.paid.v1':
      return 'Payment received'
    case 'order.shipped.v1':
      return `Order shipped (${event.payload.carrier})`
    case 'order.delivered.v1':
      return 'Order delivered'
    case 'order.confirmation_resend_requested.v1':
      return 'Confirmation resend queued'
    case 'inventory.low_stock.v1':
      return `Low stock: ${event.payload.currentQty} left`
    case 'inventory.out_of_stock.v1':
      return 'Out of stock'
    case 'payment.failed.v1':
      return 'Payment failed'
    default:
      return event.type.replace(/\./g, ' ').replace(/v\d+$/, '').trim()
  }
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  const queryClient = useQueryClient()
  const clientRef = useRef<ReturnType<typeof createSseClient> | null>(null)
  const pushEvent = useEventTicker((s) => s.pushEvent)
  const setConnected = useEventTicker((s) => s.setConnected)

  useEffect(() => {
    if (!isAuthenticated()) return

    const handleEvent = createEventHandlers(queryClient)

    const sseClient = createSseClient(
      (type, payload) => {
        handleEvent(type, payload)
        pushEvent(type, getTickerLabel({ type, payload } as DomainEvent))
      },
      {
        onConnected: () => {
          setConnected(true)
          void resyncLiveQueries(queryClient)
        },
        onDisconnected: () => setConnected(false),
      },
    )

    clientRef.current = sseClient
    sseClient.connect()

    return () => {
      sseClient.disconnect()
      clientRef.current = null
      setConnected(false)
    }
  }, [queryClient, pushEvent, setConnected])

  return <>{children}</>
}
