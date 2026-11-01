import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { NymbalEventMap, NymbalEventType, Order } from '@nymbalhq/types'
import { useNotifications } from '@/hooks/useNotifications'

/** An event as the admin handles it: its type and the payload that type carries. */
export type DomainEvent = {
  [K in NymbalEventType]: { type: K; payload: NymbalEventMap[K] }
}[NymbalEventType]

/** The list filters of hooks/useOrders.ts, as they sit in the query key. */
interface OrderListFilters {
  status?: string
  dateFrom?: string
  dateTo?: string
  customer?: string
  q?: string
  sort?: string
  limit?: number
  offset?: number
}

const ORDERS_LIST: QueryKey = ['orders', 'list']

const unset = (value: unknown): boolean => value === undefined

/** Whether a list with these filters holds an order of this status (the status alone, ignoring position). */
function statusAdmits(filters: OrderListFilters, order: Order): boolean {
  return unset(filters.status) || filters.status === order.status
}

/**
 * Whether a placed order belongs at the head of a list with these filters, decided from the order alone: the newest
 * order heads the first page of a newest-first list whose only filter is its status. Text, date and customer filters
 * need the server's matching rules, so those lists are refetched instead.
 */
function headsList(filters: OrderListFilters, order: Order): boolean {
  return (
    statusAdmits(filters, order) &&
    unset(filters.q) &&
    unset(filters.dateFrom) &&
    unset(filters.dateTo) &&
    unset(filters.customer) &&
    (unset(filters.offset) || filters.offset === 0) &&
    (unset(filters.sort) || filters.sort === 'createdAt:desc')
  )
}

function placeOrder(queryClient: QueryClient, order: Order): void {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ORDERS_LIST })) {
    const filters = (query.queryKey[2] ?? {}) as OrderListFilters
    if (!statusAdmits(filters, order)) continue
    const exact = { queryKey: query.queryKey, exact: true }
    // The GET in flight may have read before this order committed, and its response would replace a write. The
    // cancel reverts the query to its pre-fetch state at once, so the row is written now to an idle query, and the
    // refetch starts once the cancelled GET has settled.
    const cancelled =
      query.state.fetchStatus === 'fetching' ? queryClient.cancelQueries(exact) : undefined
    const old = queryClient.getQueryData<Order[]>(query.queryKey)
    const written = old !== undefined && headsList(filters, order)
    if (written) {
      const next = [order, ...old.filter((o) => o.id !== order.id)]
      queryClient.setQueryData<Order[]>(query.queryKey, next.slice(0, filters.limit ?? next.length))
    }
    if (cancelled) void cancelled.then(() => queryClient.invalidateQueries(exact))
    else if (!written) void queryClient.invalidateQueries(exact)
  }
}

/** The query groups the live handlers keep fresh. */
const LIVE_QUERY_PREFIXES: QueryKey[] = [
  ORDERS_LIST,
  ['orders', 'detail'],
  ['dashboard'],
  ['inventory', 'list'],
]

/**
 * Refetches what the live handlers maintain, for events the stream may have missed while disconnected. The cancel
 * comes first so that a fetch already in flight, which may have read before the stream subscribed, is not joined.
 * Resolves once the invalidates are issued, without waiting for their refetches.
 */
export async function resyncLiveQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    LIVE_QUERY_PREFIXES.map(async (queryKey) => {
      await queryClient.cancelQueries({ queryKey })
      void queryClient.invalidateQueries({ queryKey })
    }),
  )
}

export function createEventHandlers(queryClient: QueryClient) {
  const push = useNotifications.getState().pushNotification

  function handle(event: DomainEvent): void {
    switch (event.type) {
      case 'order.placed.v1': {
        const { order } = event.payload
        placeOrder(queryClient, order)
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
        push({
          type: 'info',
          title: 'New Order',
          message: `Order #${order.orderNumber} placed by ${order.email}`,
        })
        break
      }

      // These carry the order id and what changed, not the order: the cached copies are refetched.
      case 'order.paid.v1':
      case 'order.fulfilled.v1':
      case 'order.shipped.v1':
      case 'order.delivered.v1':
      case 'order.cancelled.v1':
      case 'order.refunded.v1':
      case 'order.partially_refunded.v1': {
        void queryClient.invalidateQueries({ queryKey: ORDERS_LIST })
        void queryClient.invalidateQueries({ queryKey: ['orders', 'detail'] })
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
        break
      }

      case 'inventory.changed.v1': {
        void queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] })
        break
      }

      case 'inventory.low_stock.v1': {
        const { variantId, currentQty, threshold } = event.payload
        push({
          type: 'warning',
          title: 'Low Stock Alert',
          message: `Variant ${variantId} is running low: ${currentQty} left (threshold ${threshold})`,
        })
        void queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] })
        break
      }

      case 'inventory.out_of_stock.v1': {
        push({
          type: 'error',
          title: 'Out of Stock',
          message: `Variant ${event.payload.variantId} is out of stock`,
        })
        void queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] })
        break
      }

      case 'payment.failed.v1': {
        const { orderId, reason } = event.payload
        push({
          type: 'error',
          title: 'Payment Failed',
          message: `Payment failed for order ${orderId}: ${reason}`,
        })
        break
      }

      case 'adapter.error.v1': {
        const { adapterType, adapterName, error } = event.payload
        push({
          type: 'error',
          title: 'Adapter Error',
          message: `${adapterType} adapter ${adapterName}: ${error.message}`,
        })
        break
      }

      default:
        break
    }
  }

  return function handleEvent<K extends NymbalEventType>(
    type: K,
    payload: NymbalEventMap[K],
  ): void {
    handle({ type, payload } as DomainEvent)
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
  /** Whether the realtime stream is confirmed live: its `connected` frame came and no error since. */
  connected: boolean
  pushEvent: (type: string, label: string) => void
  setConnected: (connected: boolean) => void
}

export const useEventTicker = create<EventTickerStore>((set) => ({
  events: [],
  connected: false,
  setConnected: (connected) => set({ connected }),
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
