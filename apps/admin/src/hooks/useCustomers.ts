import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useIntentKey } from '@/hooks/useIntentKey'
import type { Customer, Order } from '@nymbalhq/types'
import type { CustomerStats, NoteEntry } from '@/types'

interface CustomerFilters {
  q?: string | undefined
  sort?: string | undefined
  limit?: number | undefined
}

export function useCustomers(filters: CustomerFilters = {}) {
  return useQuery({
    queryKey: ['customers', 'list', filters],
    queryFn: async () => {
      const result = await api.get<{ customers: Customer[] }>(
        '/api/admin/customers',
        filters as Record<string, string | number | boolean | undefined | null>,
      )
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
    queryFn: () => api.get<Order[]>(`/api/admin/customers/${id}/orders`),
    enabled: !!id,
  })
}

/** Mails a customer waiting to confirm their email a new link; one Idempotency-Key per intent, as the order's resend. */
export function useSendVerification() {
  const [idempotencyKey, renewKey] = useIntentKey()
  return useMutation({
    mutationFn: ({ customerId }: { customerId: string }) =>
      api.post<{ sent: boolean }>(
        `/api/admin/customers/${customerId}/send-verification`,
        undefined,
        { idempotencyKey },
      ),
    onSettled: renewKey,
  })
}

/**
 * Marks a customer's email confirmed, so their password signs in. The answer replaces the cached customer, so a page
 * that reads it within the cache's stale time does not offer to confirm them again.
 */
export function useMarkVerified() {
  const queryClient = useQueryClient()
  const [idempotencyKey, renewKey] = useIntentKey()
  return useMutation({
    mutationFn: ({ customerId }: { customerId: string }) =>
      api.post<{ customer: Customer }>(
        `/api/admin/customers/${customerId}/mark-verified`,
        undefined,
        { idempotencyKey },
      ),
    onSuccess: (data, vars) => {
      queryClient.setQueryData<{ customer: Customer; stats: CustomerStats }>(
        ['customers', 'detail', vars.customerId],
        (cached) => (cached ? { ...cached, customer: data.customer } : cached),
      )
    },
    onSettled: renewKey,
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
