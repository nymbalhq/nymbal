import { useQuery, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { StockAdjustment, StockAdjustmentReason, StockStatus } from '@nymbalhq/types'
import type { InventoryRow } from '@/types'

interface InventoryFilters {
  status?: string | undefined
  q?: string | undefined
  sort?: string | undefined
  limit?: number | undefined
}

export function useInventory(filters: InventoryFilters = {}) {
  return useQuery({
    queryKey: ['inventory', 'list', filters],
    queryFn: () => api.get<InventoryRow[]>('/api/admin/inventory', filters as Record<string, string | number | boolean | undefined | null>),
  })
}

export function useInventoryHistory(variantId: string) {
  return useQuery({
    queryKey: ['inventory', 'history', variantId],
    // The route answers the adjustments themselves, newest first.
    queryFn: () => api.get<StockAdjustment[]>(`/api/admin/inventory/${variantId}/history`),
    enabled: !!variantId,
  })
}

const ADJUST_KEY = ['inventory', 'adjust']

/** The server's status for a stock (routes/admin-inventory.ts). */
function statusFor(stock: number, threshold: number): StockStatus {
  if (stock <= 0) return 'out_of_stock'
  if (stock <= threshold) return 'low_stock'
  return 'in_stock'
}

export function useAdjustStock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: ADJUST_KEY,
    mutationFn: ({
      variantId,
      delta,
      reason,
      idempotencyKey,
    }: {
      variantId: string
      delta: number
      reason: StockAdjustmentReason
      idempotencyKey?: string
    }) =>
      api.post<{ newQty: number; variantId: string }>(
        `/api/admin/inventory/${variantId}/adjust`,
        { delta, reason },
        idempotencyKey === undefined ? undefined : { idempotencyKey },
      ),
    onMutate: async ({ variantId, delta }) => {
      await queryClient.cancelQueries({ queryKey: ['inventory', 'list'] })
      // Each list the row was written in, with the row as it was, so a refusal puts back that row alone.
      const written: Array<{ queryKey: QueryKey; row: InventoryRow }> = []
      for (const query of queryClient.getQueryCache().findAll({ queryKey: ['inventory', 'list'] })) {
        const rows = queryClient.getQueryData<InventoryRow[]>(query.queryKey)
        const row = rows?.find((r) => r.variantId === variantId)
        // The server refuses a stock below zero, so a delta the stock cannot take is not shown.
        if (!rows || !row || row.stock + delta < 0) continue
        const stock = row.stock + delta
        const next = { ...row, stock, status: statusFor(stock, row.threshold) }
        queryClient.setQueryData<InventoryRow[]>(
          query.queryKey,
          rows.map((r) => (r.variantId === variantId ? next : r)),
        )
        written.push({ queryKey: query.queryKey, row })
      }
      return { written }
    },
    onError: (_err, { variantId }, context) => {
      for (const { queryKey, row } of context?.written ?? []) {
        queryClient.setQueryData<InventoryRow[]>(queryKey, (rows) =>
          rows?.map((r) => (r.variantId === variantId ? row : r)),
        )
      }
    },
    onSettled: () => {
      // The settling adjust still counts as in flight here. While another is in flight a refetch could read stock
      // from before that one committed and replace its optimistic row, so only the last to settle refetches.
      if (queryClient.isMutating({ mutationKey: ADJUST_KEY }) > 1) return
      void queryClient.invalidateQueries({ queryKey: ['inventory'] })
      void queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })
}
