import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useIntentWrites } from '@/hooks/useIntentWrites'
import { api } from '@/lib/api'
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

const REFRESH = [['promotions']] as const

const NEW = 'new'

export function useCreatePromotion() {
  const { run, pending } = useIntentWrites(REFRESH)
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
  const { run, pending } = useIntentWrites(REFRESH)
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
  const { run, pending } = useIntentWrites(REFRESH)
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
