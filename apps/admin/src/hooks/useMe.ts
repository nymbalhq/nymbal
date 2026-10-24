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
