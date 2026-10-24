import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { AsOfRead, HistoryPage } from '@nymbalhq/types'
import { api } from '@/lib/api'

export type HistoryCollection = 'orders' | 'products' | 'customers'

const PAGE = 50

/** A record's changes from the event log, newest first, a page at a time. */
export function useHistory(collection: HistoryCollection, id: string) {
  return useInfiniteQuery({
    queryKey: ['history', collection, id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<HistoryPage>(`/api/admin/${collection}/${encodeURIComponent(id)}/history`, {
        limit: PAGE,
        cursor: pageParam,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: id !== '',
  })
}

/** The record its admin detail read (`detailPath`) answers as of `at`, folded from the event log. */
export function useAsOf(detailPath: string, at: string | null) {
  return useQuery({
    queryKey: ['history', 'as-of', detailPath, at],
    queryFn: () => api.get<AsOfRead>(detailPath, { at }),
    enabled: at !== null,
    retry: false,
  })
}
