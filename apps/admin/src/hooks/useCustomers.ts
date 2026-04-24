import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Customer, CustomerStats, Order, NoteEntry } from '@/types'

interface CustomerFilters {
  q?: string | undefined
  sort?: string | undefined
  limit?: number | undefined
}

export function useCustomers(filters: CustomerFilters = {}) {
  return useQuery({
    queryKey: ['customers', 'list', filters],
    queryFn: async () => {
      const result = await api.get<{ customers: Customer[] }>('/api/admin/customers', filters as Record<string, string | number | boolean | undefined | null>)
      return result.customers
    },
  })
}

export function useCustomer(id: string) {
  return useQuery({
    queryKey: ['customers', 'detail', id],
    queryFn: () =>
      api.get<{ customer: Customer; stats: CustomerStats }>(`/api/admin/customers/${id}`),
    enabled: !!id,
  })
}

export function useCustomerOrders(id: string) {
  return useQuery({
    queryKey: ['customers', 'orders', id],
    queryFn: async () => {
      const result = await api.get<{ orders: Order[] }>(`/api/admin/customers/${id}/orders`)
      return result.orders
    },
    enabled: !!id,
  })
}

export function useAddCustomerNote() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ customerId, body }: { customerId: string; body: string }) =>
      api.post<{ note: NoteEntry }>(`/api/admin/customers/${customerId}/notes`, { body }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['customers', 'detail', vars.customerId] })
    },
  })
}
