import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { InventoryRow, StockAdjustment, StockAdjustmentReason } from '@/types'

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
    queryFn: async () => {
      const result = await api.get<{ history: StockAdjustment[] }>(`/api/admin/inventory/${variantId}/history`)
      return result.history
    },
    enabled: !!variantId,
  })
}

export function useAdjustStock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ variantId, delta, reason }: { variantId: string; delta: number; reason: StockAdjustmentReason }) =>
      api.post<{ newQty: number; variantId: string }>(`/api/admin/inventory/${variantId}/adjust`, { delta, reason }),
    onMutate: async ({ variantId, delta }) => {
      await queryClient.cancelQueries({ queryKey: ['inventory', 'list'] })
      const previousData = queryClient.getQueryData<InventoryRow[]>(['inventory', 'list', {}])
      if (previousData) {
        queryClient.setQueryData(
          ['inventory', 'list', {}],
          previousData.map((row) =>
            row.variantId === variantId
              ? { ...row, stock: Math.max(0, row.stock + delta) }
              : row
          )
        )
      }
      return { previousData }
    },
    onError: (_err, _vars, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['inventory', 'list', {}], context.previousData)
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}
