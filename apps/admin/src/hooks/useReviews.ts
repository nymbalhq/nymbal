import { useCallback, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AdminReview, ReviewModerationStatus } from '@nymbalhq/types'
import { api, newIdempotencyKey } from '@/lib/api'

export type ReviewDecision = 'approved' | 'rejected'

/** The reviews of one moderation status, newest first. */
export function useReviews(status: ReviewModerationStatus) {
  return useQuery({
    queryKey: ['reviews', 'list', status],
    queryFn: () => api.get<AdminReview[]>('/api/admin/reviews', { status }),
  })
}

/**
 * Decides reviews, one decision per row at a time. Each row's decision holds its own Idempotency-Key until it
 * settles: one key shared across rows would be refused for the second row, and a click on a row whose decision is
 * still open sends nothing, so an Approve and a Reject of one review never race.
 */
export function useModerateReview() {
  const queryClient = useQueryClient()
  const keys = useRef(new Map<string, string>())
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(() => new Set())
  const mutation = useMutation({
    mutationFn: ({
      id,
      status,
      idempotencyKey,
    }: {
      id: string
      status: ReviewDecision
      idempotencyKey: string
    }) =>
      api.post<{ ok: true }>(
        `/api/admin/reviews/${encodeURIComponent(id)}/moderate`,
        { status },
        { idempotencyKey },
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['reviews'] }),
  })
  const { mutateAsync } = mutation

  /** Sends the row's decision; null, and nothing sent, while that row's decision is open. */
  const moderate = useCallback(
    (input: { id: string; status: ReviewDecision }): Promise<unknown> | null => {
      if (keys.current.has(input.id)) return null
      const idempotencyKey = newIdempotencyKey()
      keys.current.set(input.id, idempotencyKey)
      setDeciding(new Set(keys.current.keys()))
      return mutateAsync({ ...input, idempotencyKey }).finally(() => {
        keys.current.delete(input.id)
        setDeciding(new Set(keys.current.keys()))
      })
    },
    [mutateAsync],
  )

  return { moderate, deciding }
}
