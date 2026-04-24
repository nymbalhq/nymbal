import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Order, OrderWithHistory, OrderHistoryEntry, NoteEntry } from '@/types'

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
    queryFn: () => api.get<Order[]>('/api/admin/orders', filters as Record<string, string | number | boolean | undefined | null>),
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
    queryFn: async () => {
      const result = await api.get<{ notes: NoteEntry[] }>(`/api/admin/orders/${orderId}/notes`)
      return result.notes
    },
    enabled: !!orderId,
  })
}

export function useUpdateOrderStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ orderId, action, body }: { orderId: string; action: string; body?: Record<string, unknown> }) => {
      return api.post<Order>(`/api/admin/orders/${orderId}/${action}`, body)
    },
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(['orders', 'detail', updatedOrder.orderNumber], (old: OrderWithHistory | undefined) =>
        old ? { ...old, ...updatedOrder } : updatedOrder
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useConfirmOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (orderId: string) => api.post<Order>(`/api/admin/orders/${orderId}/confirm`),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(['orders', 'detail', updatedOrder.orderNumber], (old: OrderWithHistory | undefined) =>
        old ? { ...old, ...updatedOrder } : updatedOrder
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
    },
  })
}

export function useCancelOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason?: string }) =>
      api.post<Order>(`/api/admin/orders/${orderId}/cancel`, { reason }),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(['orders', 'detail', updatedOrder.orderNumber], (old: OrderWithHistory | undefined) =>
        old ? { ...old, ...updatedOrder } : updatedOrder
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
    },
  })
}

export function useMarkPaidOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ orderId, paymentIntentId, amountMinor, currency }: { orderId: string; paymentIntentId: string; amountMinor: number; currency: string }) =>
      api.post<Order>(`/api/admin/orders/${orderId}/mark-paid`, { paymentIntentId, amountMinor, currency }),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(['orders', 'detail', updatedOrder.orderNumber], (old: OrderWithHistory | undefined) =>
        old ? { ...old, ...updatedOrder } : updatedOrder
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
    },
  })
}

export function useMarkDeliveredOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (orderId: string) => api.post<Order>(`/api/admin/orders/${orderId}/mark-delivered`),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(['orders', 'detail', updatedOrder.orderNumber], (old: OrderWithHistory | undefined) =>
        old ? { ...old, ...updatedOrder } : updatedOrder
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
    },
  })
}

export function useShipOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ orderId, trackingNumber, carrier }: { orderId: string; trackingNumber: string; carrier: string }) =>
      api.post<Order>(`/api/admin/orders/${orderId}/ship`, { trackingNumber, carrier }),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(['orders', 'detail', updatedOrder.orderNumber], (old: OrderWithHistory | undefined) =>
        old ? { ...old, ...updatedOrder } : updatedOrder
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
    },
  })
}

export function useRefundOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ orderId, amountMinor, reason }: { orderId: string; amountMinor: number; reason?: string }) =>
      api.post<Order>(`/api/admin/orders/${orderId}/refund`, { amountMinor, reason }),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(['orders', 'detail', updatedOrder.orderNumber], (old: OrderWithHistory | undefined) =>
        old ? { ...old, ...updatedOrder } : updatedOrder
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
    },
  })
}

export function usePartialRefundOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ orderId, amountMinor, reason, lineItems }: { orderId: string; amountMinor: number; reason?: string; lineItems: unknown[] }) =>
      api.post<Order>(`/api/admin/orders/${orderId}/partial-refund`, { amountMinor, reason, lineItems }),
    onSuccess: (updatedOrder) => {
      queryClient.setQueryData(['orders', 'detail', updatedOrder.orderNumber], (old: OrderWithHistory | undefined) =>
        old ? { ...old, ...updatedOrder } : updatedOrder
      )
      queryClient.invalidateQueries({ queryKey: ['orders', 'list'] })
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
