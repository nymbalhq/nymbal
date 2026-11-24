import { useCallback, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, newIdempotencyKey } from '@/lib/api'
import type { AdminPromotion } from '@/types'

/** What a create or a full edit sends: every field, a cleared one as null. */
export interface PromotionFields {
  code: string
  kind: 'percent' | 'fixed'
  percentBps: number | null
  amountOffMinor: number | null
  currency: string | null
  minimumSubtotalMinor: number | null
  expiresAt: string | null
  usageCap: number | null
  active: boolean
}

/** The store's newest promotions, as many as the route gives. */
export function usePromotions() {
  return useQuery({
    queryKey: ['promotions', 'list'],
    queryFn: () => api.get<AdminPromotion[]>('/api/admin/promotions', { limit: 200 }),
  })
}

/**
 * Writes keyed by intent: each intent (a row's, or the new code's) holds its own Idempotency-Key until its command
 * settles, and a send for an intent still open sends nothing. One key across rows would be refused for the second row.
 */
function useIntentWrites() {
  const queryClient = useQueryClient()
  const keys = useRef(new Map<string, string>())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  /**
   * Sends `write` under the intent's key; null, and nothing sent, while that intent's command is open. The command
   * settles once the list is read again: a row released on the write's answer alone still shows the old values, and
   * an Edit opened from it would send them back.
   */
  const run = useCallback(
    <T>(intent: string, write: (idempotencyKey: string) => Promise<T>): Promise<T> | null => {
      if (keys.current.has(intent)) return null
      const idempotencyKey = newIdempotencyKey()
      keys.current.set(intent, idempotencyKey)
      setPending(new Set(keys.current.keys()))
      const settle = async () => {
        try {
          await queryClient.invalidateQueries({ queryKey: ['promotions'] })
        } finally {
          keys.current.delete(intent)
          setPending(new Set(keys.current.keys()))
        }
      }
      return write(idempotencyKey).then(
        async (answer) => {
          await settle()
          return answer
        },
        async (err: unknown) => {
          await settle()
          throw err
        },
      )
    },
    [queryClient],
  )

  return { run, pending }
}

const NEW = 'new'

export function useCreatePromotion() {
  const { run, pending } = useIntentWrites()
  const create = useCallback(
    (fields: PromotionFields) =>
      run(NEW, (idempotencyKey) =>
        api.post<AdminPromotion>('/api/admin/promotions', fields, { idempotencyKey }),
      ),
    [run],
  )
  return { create, creating: pending.has(NEW) }
}

/** Switch off, Switch on and Edit of one row share its key until the command settles. */
export function useUpdatePromotion() {
  const { run, pending } = useIntentWrites()
  const update = useCallback(
    (id: string, fields: Partial<PromotionFields>) =>
      run(id, (idempotencyKey) =>
        api.patch<AdminPromotion>(`/api/admin/promotions/${encodeURIComponent(id)}`, fields, {
          idempotencyKey,
        }),
      ),
    [run],
  )
  return { update, updating: pending }
}

export function useDeletePromotion() {
  const { run, pending } = useIntentWrites()
  const remove = useCallback(
    (id: string) =>
      run(id, (idempotencyKey) =>
        api.delete<{ ok: true }>(`/api/admin/promotions/${encodeURIComponent(id)}`, {
          idempotencyKey,
        }),
      ),
    [run],
  )
  return { remove, deleting: pending }
}
