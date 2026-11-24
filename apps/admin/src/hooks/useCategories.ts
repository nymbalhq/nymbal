import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Category } from '@nymbalhq/types'
import { useIntentWrites } from '@/hooks/useIntentWrites'
import { api } from '@/lib/api'

const PATH = '/api/admin/categories'
const REFRESH = [['categories']] as const
// A delete takes the category from its products, so their copies are read again too.
const REFRESH_WITH_PRODUCTS = [['categories'], ['products']] as const

export interface NewCategory {
  slug: string
  name: string
  description: string
  parentId: string | null
}

/** Slugs do not change once made. */
export type CategoryChanges = Omit<NewCategory, 'slug'>

export interface DeletedCategory {
  ok: true
  detachedProducts: number
  movedChildren: number
}

/** Every category, in the store's order: position, then name. */
export function useCategories() {
  return useQuery({
    queryKey: ['categories', 'list'],
    queryFn: async () => {
      const categories = await api.get<unknown>(PATH)
      // The product form shows this list beside its own fields: an answer that is not a list is a failed read there,
      // never a broken form.
      if (!Array.isArray(categories)) throw new Error('The categories answer is not a list')
      return categories as Category[]
    },
  })
}

const pathOf = (id: string) => `${PATH}/${encodeURIComponent(id)}`

export function useCreateCategory() {
  const { run, pending } = useIntentWrites(REFRESH)
  const create = useCallback(
    (fields: NewCategory) =>
      run('new', (idempotencyKey) => api.post<Category>(PATH, fields, { idempotencyKey })),
    [run],
  )
  return { create, creating: pending.has('new') }
}

export function useUpdateCategory() {
  const { run, pending } = useIntentWrites(REFRESH)
  const update = useCallback(
    (id: string, fields: CategoryChanges) =>
      run(id, (idempotencyKey) => api.patch<Category>(pathOf(id), fields, { idempotencyKey })),
    [run],
  )
  return { update, updating: pending }
}

export function useDeleteCategory() {
  const { run, pending } = useIntentWrites(REFRESH_WITH_PRODUCTS)
  const remove = useCallback(
    (id: string) =>
      run(id, (idempotencyKey) => api.delete<DeletedCategory>(pathOf(id), { idempotencyKey })),
    [run],
  )
  return { remove, deleting: pending }
}

/** The intent of a reorder under `parentId`: one parent's move open never holds another's. */
export const reorderIntent = (parentId: string | null) => parentId ?? ''

export function useReorderCategories() {
  const { run, pending } = useIntentWrites(REFRESH)
  const reorder = useCallback(
    (parentId: string | null, ids: string[]) =>
      run(reorderIntent(parentId), (idempotencyKey) =>
        api.post<Category[]>(`${PATH}/reorder`, { parentId, ids }, { idempotencyKey }),
      ),
    [run],
  )
  return { reorder, reordering: pending }
}
