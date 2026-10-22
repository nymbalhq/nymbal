import { useInfiniteQuery } from '@tanstack/react-query'
import type { AuditEntry } from '@nymbalhq/types'
import { api } from '@/lib/api'

export interface ActivityFilters {
  actor?: string
  command?: string
  subject?: string
  correlation?: string
  outcome?: string
  since?: string
  until?: string
}

const PAGE = 100

/** Audit entries newest first, a page at a time, narrowed by `filters`. */
export function useActivity(filters: ActivityFilters) {
  return useInfiniteQuery({
    queryKey: ['activity', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.getPage<AuditEntry[]>('/api/admin/activity', {
        ...filters,
        limit: PAGE,
        cursor: pageParam,
      }),
    getNextPageParam: (page) => {
      const next = page.meta?.['nextCursor']
      return typeof next === 'string' && next !== '' ? next : undefined
    },
  })
}

/** The entries `GET /api/admin/activity/export` streams for the window, as NDJSON text. */
export function exportActivity(filters: Pick<ActivityFilters, 'since' | 'until' | 'correlation'>) {
  return api.getText('/api/admin/activity/export', filters)
}
