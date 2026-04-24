import type { QueryClient } from '@tanstack/react-query'
import type { Order, InventoryRow, OrderWithHistory } from '@/types'
import { useNotifications } from '@/hooks/useNotifications'

export function createEventHandlers(queryClient: QueryClient) {
  const push = useNotifications.getState().pushNotification

  return function handleEvent(type: string, data: unknown) {
    switch (type) {
      case 'order.placed.v1': {
        const order = data as Order
        // Prepend to order list caches
        queryClient.setQueriesData<Order[]>(
          { queryKey: ['orders', 'list'] },
          (old) => (old ? [order, ...old] : [order])
        )
        queryClient.invalidateQueries({ queryKey: ['dashboard'] })
        push({
          type: 'info',
          title: 'New Order',
          message: `Order #${order.orderNumber} placed by ${order.email}`,
        })
        break
      }

      case 'order.paid.v1':
      case 'order.confirmed.v1':
      case 'order.processing.v1':
      case 'order.shipped.v1':
      case 'order.delivered.v1':
      case 'order.cancelled.v1':
      case 'order.refunded.v1': {
        const order = data as Order
        // Patch in list caches
        queryClient.setQueriesData<Order[]>(
          { queryKey: ['orders', 'list'] },
          (old) => old?.map((o) => (o.id === order.id ? { ...o, ...order } : o))
        )
        // Patch detail cache
        queryClient.setQueryData<OrderWithHistory>(
          ['orders', 'detail', order.orderNumber],
          (old) => (old ? { ...old, ...order } : undefined)
        )
        queryClient.invalidateQueries({ queryKey: ['dashboard'] })
        break
      }

      case 'inventory.changed.v1': {
        const row = data as Partial<InventoryRow> & { variantId: string }
        queryClient.setQueriesData<InventoryRow[]>(
          { queryKey: ['inventory', 'list'] },
          (old) => old?.map((r) => (r.variantId === row.variantId ? { ...r, ...row } : r))
        )
        break
      }

      case 'inventory.low_stock.v1': {
        const row = data as InventoryRow
        push({
          type: 'warning',
          title: 'Low Stock Alert',
          message: `${row.productName} (${row.sku}) is running low — ${row.stock} remaining`,
        })
        queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] })
        break
      }

      case 'inventory.out_of_stock.v1': {
        const row = data as InventoryRow
        push({
          type: 'error',
          title: 'Out of Stock',
          message: `${row.productName} (${row.sku}) is out of stock`,
        })
        queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] })
        break
      }

      case 'payment.failed.v1': {
        const payload = data as { orderId?: string; orderNumber?: string; amount?: number }
        push({
          type: 'error',
          title: 'Payment Failed',
          message: payload.orderNumber
            ? `Payment failed for order #${payload.orderNumber}`
            : 'A payment has failed',
        })
        break
      }

      case 'adapter.error.v1': {
        const payload = data as { adapter?: string; message?: string }
        push({
          type: 'error',
          title: 'Adapter Error',
          message: payload.message ?? `Adapter ${payload.adapter ?? 'unknown'} encountered an error`,
        })
        break
      }

      default:
        break
    }
  }
}

// Store for event ticker (last N events for TopBar display)
import { create } from 'zustand'

interface TickerEvent {
  id: string
  type: string
  label: string
  at: string
}

interface EventTickerStore {
  events: TickerEvent[]
  pushEvent: (type: string, label: string) => void
}

export const useEventTicker = create<EventTickerStore>((set) => ({
  events: [],
  pushEvent: (type, label) => {
    const event: TickerEvent = {
      id: crypto.randomUUID(),
      type,
      label,
      at: new Date().toISOString(),
    }
    set((state) => ({
      events: [event, ...state.events].slice(0, 20),
    }))
  },
}))
