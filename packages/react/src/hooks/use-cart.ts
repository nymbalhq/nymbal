import { useSyncExternalStore } from 'react'
import type { CartState } from '@nymbal/sdk'
import { useNymbalClient } from '../context.js'

export interface UseCartReturn extends CartState {
  addItem: (variantId: string, qty?: number) => Promise<void>
  removeItem: (variantId: string) => Promise<void>
  updateQuantity: (variantId: string, qty: number) => Promise<void>
  clear: () => Promise<void>
  load: () => Promise<void>
}

export function useCart(): UseCartReturn {
  const client = useNymbalClient()
  const state = useSyncExternalStore(
    client.cart.subscribe,
    client.cart.getState,
    client.cart.getState,
  )
  return {
    ...state,
    addItem: client.cart.addItem,
    removeItem: client.cart.removeItem,
    updateQuantity: client.cart.updateQuantity,
    clear: client.cart.clear,
    load: client.cart.load,
  }
}
