import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { InsightList, InsightView } from '@nymbalhq/types'
import { api } from '@/lib/api'
import { useIntentKey } from '@/hooks/useIntentKey'

/** The night shift's open insights, in the order the server answers them: the most serious first. */
export function useInsights() {
  return useQuery({
    queryKey: ['insights', 'list'],
    queryFn: () => api.get<InsightList>('/api/admin/insights'),
  })
}

/**
 * Dismisses one insight; its key is this intent's, so a second click before the re-render is the same dismiss. Settles
 * once the list is read again, so a dismissed card is gone by then.
 */
export function useDismissInsight() {
  const queryClient = useQueryClient()
  const [idempotencyKey, renewKey] = useIntentKey()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<InsightView>(`/api/admin/insights/${encodeURIComponent(id)}/dismiss`, undefined, {
        idempotencyKey,
      }),
    onSettled: async () => {
      renewKey()
      await queryClient.invalidateQueries({ queryKey: ['insights'] })
    },
  })
}
