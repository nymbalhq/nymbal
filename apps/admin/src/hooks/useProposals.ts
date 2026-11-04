import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProposalPage, ProposalView } from '@nymbalhq/types'
import { api } from '@/lib/api'
import { useIntentKey } from '@/hooks/useIntentKey'

export type ProposalTab = 'pending' | 'decided'

const PAGE = 50

/** Agent proposals newest first, a page at a time: the pending ones, or the decided ones. */
export function useProposals(status: ProposalTab) {
  return useInfiniteQuery({
    queryKey: ['proposals', 'list', status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<ProposalPage>('/api/admin/proposals', { status, limit: PAGE, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
}

/** How many proposals wait for a decision. */
export function usePendingProposalCount() {
  return useQuery({
    queryKey: ['proposals', 'count'],
    queryFn: async () =>
      (await api.get<ProposalPage>('/api/admin/proposals', { status: 'pending', limit: 1 }))
        .pending,
  })
}

/** Approves one proposal; its key is this intent's, so a second click before the re-render is the same approval. */
export function useApproveProposal() {
  const queryClient = useQueryClient()
  const [idempotencyKey, renewKey] = useIntentKey()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<ProposalView>(`/api/admin/proposals/${encodeURIComponent(id)}/approve`, undefined, {
        idempotencyKey,
      }),
    onSettled: () => {
      renewKey()
      void queryClient.invalidateQueries({ queryKey: ['proposals'] })
    },
  })
}

export function useRejectProposal() {
  const queryClient = useQueryClient()
  const [idempotencyKey, renewKey] = useIntentKey()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<ProposalView>(
        `/api/admin/proposals/${encodeURIComponent(id)}/reject`,
        reason === '' ? {} : { reason },
        { idempotencyKey },
      ),
    onSettled: () => {
      renewKey()
      void queryClient.invalidateQueries({ queryKey: ['proposals'] })
    },
  })
}
