import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { NymbalProvider } from '../context.js'
import { useCart } from './use-cart.js'
import type { NymbalClient, CartState } from '@nymbalhq/sdk'
import type { ReactNode } from 'react'

function makeCartStore(initialState: Partial<CartState> = {}) {
  let state: CartState = {
    items: [],
    subtotalMinor: 0,
    currency: 'GBP',
    itemCount: 0,
    loading: false,
    error: null,
    ...initialState,
  }
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (partial: Partial<CartState>) => {
      state = { ...state, ...partial }
      for (const l of listeners) l()
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    addItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    updateQuantity: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  }
}

function makeClient(cartStore = makeCartStore()): NymbalClient {
  return { cart: cartStore } as unknown as NymbalClient
}

function makeWrapper(client: NymbalClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <NymbalProvider client={client}>{children}</NymbalProvider>
  }
}

describe('useCart', () => {
  it('mounts with the store’s current cart, not a default', () => {
    const cartStore = makeCartStore({ itemCount: 2, subtotalMinor: 2400 })
    const { result } = renderHook(() => useCart(), { wrapper: makeWrapper(makeClient(cartStore)) })
    expect(result.current.itemCount).toBe(cartStore.getState().itemCount)
    expect(result.current.subtotalMinor).toBe(cartStore.getState().subtotalMinor)
  })

  it('re-renders when cart state changes', () => {
    const cartStore = makeCartStore()
    const client = makeClient(cartStore)
    const { result } = renderHook(() => useCart(), { wrapper: makeWrapper(client) })
    act(() => {
      cartStore.setState({ itemCount: 3, subtotalMinor: 3000 })
    })
    expect(result.current.itemCount).toBe(3)
  })
})
