import { useSyncExternalStore } from 'react'
import type { SearchState } from '@nymbal/sdk'
import { useNymbalClient } from '../context.js'

export interface UseSearchReturn extends SearchState {
  search: (query: string) => Promise<void>
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
    clearSearch: client.search.clearSearch,
  }
}
