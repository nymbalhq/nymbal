import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Order, ProductSnapshot, Customer } from '@/types'

interface SearchResults {
  orders: Order[]
  products: ProductSnapshot[]
  customers: Customer[]
}

export function useGlobalSearch(q: string) {
  return useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<SearchResults>('/api/admin/search', { q }),
    enabled: q.length >= 2,
    staleTime: 10_000,
  })
}
