import { useSyncExternalStore } from 'react'
import type { SearchState } from '@nymbalhq/sdk'
import { useNymbalClient } from '../context.js'

export interface UseSearchReturn extends SearchState {
  search: (query: string, options?: { category?: string | null }) => Promise<void>
  loadMore: () => Promise<void>
  setCategory: (category: string | null) => Promise<void>
  clearSearch: () => void
}

export function useSearch(): UseSearchReturn {
  const client = useNymbalClient()
  const state = useSyncExternalStore(
    client.search.subscribe,
    client.search.getState,
    client.search.getState,
  )
  return {
    ...state,
    search: client.search.search,
    loadMore: client.search.loadMore,
    setCategory: client.search.setCategory,
    clearSearch: client.search.clearSearch,
  }
}
