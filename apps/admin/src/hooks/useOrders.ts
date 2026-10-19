import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { OrderHistoryEntry } from '@nymbalhq/types'
import type { AdminOrder, OrderWithHistory, NoteEntry, RefundAnswer } from '@/types'

interface OrderFilters {
  status?: string | undefined
  dateFrom?: string | undefined
  dateTo?: string | undefined
  customer?: string | undefined
  q?: string | undefined
  sort?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export function useOrders(filters: OrderFilters = {}) {
  return useQuery({
    queryKey: ['orders', 'list', filters],
    queryFn: () =>
      api.get<AdminOrder[]>(
        '/api/admin/orders',
        filters as Record<string, string | number | boolean | undefined | null>,
      ),
  })
}

export function useOrder(orderNumber: string) {
  return useQuery({
    queryKey: ['orders', 'detail', orderNumber],
    queryFn: () => api.get<OrderWithHistory>(`/api/admin/orders/${orderNumber}`),
    enabled: !!orderNumber,
  })
}

export function useOrderTimeline(orderId: string) {
  return useQuery({
    queryKey: ['orders', 'timeline', orderId],
    queryFn: () => api.get<OrderHistoryEntry[]>(`/api/admin/orders/${orderId}/timeline`),
    enabled: !!orderId,
  })
}

export function useOrderNotes(orderId: string) {
  return useQuery({
    queryKey: ['orders', 'notes', orderId],
    // GET /api/admin/orders/:id/notes returns NoteEntry[] inside the envelope
    queryFn: () => api.get<NoteEntry[]>(`/api/admin/orders/${orderId}/notes`),
    enabled: !!orderId,
  })
}

export function useUpdateOrderStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      orderId,
      action,
      body,
    }: {
      orderId: string
      action: string
      body?: Record<string, unknown>
    }) => {
      return api.post<AdminOrder>(`/api/admin/orders/${orderId}/${action}`, body)
    },
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(
        ['orders', 'detail', updatedOrder.orderNumber],
        (old: OrderWithHistory | undefined) => (old ? { ...old, ...updatedOrder } : updatedOrder),
      )
      // Refetch the detail document so the status history/timeline stays in sync
      queryClient.invalidateQueries({ queryKey: ['orders', 'detail', updatedOrder.orderNumber] })
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useCancelOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason?: string }) =>
      api.post<AdminOrder>(`/api/admin/orders/${orderId}/cancel`, { reason }),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(
        ['orders', 'detail', updatedOrder.orderNumber],
        (old: OrderWithHistory | undefined) => (old ? { ...old, ...updatedOrder } : updatedOrder),
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
    },
  })
}

/** Records a payment taken outside the store: a manual capture of the order's total, which confirms it. */
export function useMarkPaidOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ orderId, note }: { orderId: string; note?: string }) =>
      api.post<AdminOrder>(`/api/admin/orders/${orderId}/mark-paid`, note ? { note } : {}),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(
        ['orders', 'detail', updatedOrder.orderNumber],
        (old: OrderWithHistory | undefined) => (old ? { ...old, ...updatedOrder } : updatedOrder),
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'detail', updatedOrder.orderNumber] })
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useMarkDeliveredOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (orderId: string) =>
      api.post<AdminOrder>(`/api/admin/orders/${orderId}/mark-delivered`),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(
        ['orders', 'detail', updatedOrder.orderNumber],
        (old: OrderWithHistory | undefined) => (old ? { ...old, ...updatedOrder } : updatedOrder),
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
    },
  })
}

export function useShipOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      orderId,
      trackingNumber,
      carrier,
    }: {
      orderId: string
      trackingNumber: string
      carrier: string
    }) => api.post<AdminOrder>(`/api/admin/orders/${orderId}/ship`, { trackingNumber, carrier }),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(
        ['orders', 'detail', updatedOrder.orderNumber],
        (old: OrderWithHistory | undefined) => (old ? { ...old, ...updatedOrder } : updatedOrder),
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
    },
  })
}

/** A refund of an amount up to what is refundable; the page is refetched before the mutation settles. */
export function useRefundOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      orderId,
      amountMinor,
      reason,
    }: {
      orderId: string
      amountMinor: number
      reason?: string
    }) =>
      api.post<RefundAnswer>(
        `/api/admin/orders/${orderId}/refund`,
        reason ? { amountMinor, reason } : { amountMinor },
      ),
    onSuccess: async (answer) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders', 'detail', answer.order.orderNumber] }),
        queryClient.invalidateQueries({ queryKey: ['orders', 'list'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
    },
  })
}

export function useAddOrderNote() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ orderId, body }: { orderId: string; body: string }) =>
      api.post<{ note: NoteEntry }>(`/api/admin/orders/${orderId}/notes`, { body }),
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['orders', 'notes', vars.orderId] })
    },
  })
}
