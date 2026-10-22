import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SettingsListing, SettingWriteResult } from '@nymbalhq/types'
import { api } from '@/lib/api'

const fieldUrl = (slot: string, path: string) =>
  `/api/admin/settings/${encodeURIComponent(slot)}/${encodeURIComponent(path)}`

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsListing>('/api/admin/settings'),
  })
}

/** Saves a field's value; the API never answers with it, and it applies at the next start. */
export function useSaveSetting() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ slot, path, value }: { slot: string; path: string; value: string }) =>
      api.put<SettingWriteResult>(fieldUrl(slot, path), { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  })
}

export function useClearSetting() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ slot, path }: { slot: string; path: string }) =>
      api.delete<SettingWriteResult>(fieldUrl(slot, path)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  })
}
