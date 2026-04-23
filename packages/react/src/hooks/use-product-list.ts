import { useSyncExternalStore } from 'react'
import type { ProductListState, ProductListParams } from '@nymbal/sdk'
import { useNymbalClient } from '../context.js'

export interface UseProductListReturn extends ProductListState {
  load: (params?: ProductListParams) => Promise<void>
  loadMore: () => Promise<void>
  applyFilter: (name: string, value: string | string[]) => Promise<void>
  removeFilter: (name: string) => Promise<void>
  setSort: (field: string, direction: 'asc' | 'desc') => Promise<void>
}

export function useProductList(): UseProductListReturn {
  const client = useNymbalClient()
  const state = useSyncExternalStore(
    client.productList.subscribe,
    client.productList.getState,
    client.productList.getState,
  )
  return {
    ...state,
    load: client.productList.load,
    loadMore: client.productList.loadMore,
    applyFilter: client.productList.applyFilter,
    removeFilter: client.productList.removeFilter,
    setSort: client.productList.setSort,
  }
}
