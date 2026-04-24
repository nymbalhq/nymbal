import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ProductSnapshot } from '@/types'

interface ProductFilters {
  status?: string | undefined
  q?: string | undefined
  sort?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export function useProducts(filters: ProductFilters = {}) {
  return useQuery({
    queryKey: ['products', 'list', filters],
    queryFn: () => api.get<ProductSnapshot[]>('/api/admin/products', filters as Record<string, string | number | boolean | undefined | null>),
  })
}

export function useProduct(idOrSlug: string) {
  return useQuery({
    queryKey: ['products', 'detail', idOrSlug],
    queryFn: () => api.get<ProductSnapshot>(`/api/admin/products/${idOrSlug}`),
    enabled: !!idOrSlug && idOrSlug !== 'new',
  })
}

export function useCreateProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (product: Partial<ProductSnapshot>) => api.post<ProductSnapshot>('/api/admin/products', product),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products', 'list'] })
    },
  })
}

export function useUpdateProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ProductSnapshot> }) =>
      api.patch<ProductSnapshot>(`/api/admin/products/${id}`, data),
    onSuccess: (updated) => {
      queryClient.setQueryData(['products', 'detail', updated.id], updated)
      queryClient.setQueryData(['products', 'detail', updated.slug], updated)
      queryClient.invalidateQueries({ queryKey: ['products', 'list'] })
    },
  })
}

export function useDeleteProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/admin/products/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products', 'list'] })
    },
  })
}

export function usePublishProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/api/admin/products/${id}/publish`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })
}

export function useUnpublishProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/api/admin/products/${id}/unpublish`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })
}

export function useDuplicateProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<ProductSnapshot>(`/api/admin/products/${id}/duplicate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products', 'list'] })
    },
  })
}

export function useArchiveProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/api/admin/products/${id}/archive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })
}

export function useEnhanceProduct() {
  return useMutation({
    mutationFn: ({ id, field, context }: { id: string; field: string; context?: Record<string, string> }) =>
      api.post<{ suggestion: string }>(`/api/admin/products/${id}/enhance`, { field, context }),
  })
}
