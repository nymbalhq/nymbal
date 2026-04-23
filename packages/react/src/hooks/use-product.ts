import { useSyncExternalStore, useEffect } from 'react'
import type { ProductState, DenormalisedVariant } from '@nymbal/sdk'
import { useNymbalClient } from '../context.js'

export interface UseProductReturn extends ProductState {
  loadBySlug: (slug: string) => Promise<void>
  selectVariant: (variant: DenormalisedVariant | null) => void
}

export function useProduct(slug?: string): UseProductReturn {
  const client = useNymbalClient()
  const state = useSyncExternalStore(
    client.product.subscribe,
    client.product.getState,
    client.product.getState,
  )

  useEffect(() => {
    if (slug) {
      client.product.loadBySlug(slug)
    }
  }, [slug, client.product])

  return {
    ...state,
    loadBySlug: client.product.loadBySlug,
    selectVariant: client.product.selectVariant,
  }
}
