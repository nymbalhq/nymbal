import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AdminMe } from '@/types'

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<AdminMe>('/api/admin/me'),
    staleTime: 5 * 60_000,
  })
}

/** The store's currency from the session answer; undefined until it is in, or when it failed. */
export function useStoreCurrency(): string | undefined {
  return useMe().data?.currency
}
