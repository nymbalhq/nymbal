import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { NymbalProvider } from '../context.js'
import { useCart } from './use-cart.js'
import type { NymbalClient, CartState } from '@nymbal/sdk'
import type { ReactNode } from 'react'

function makeCartStore(initialState: Partial<CartState> = {}) {
  let state: CartState = {
    items: [], subtotalMinor: 0, currency: 'GBP',
    itemCount: 0, loading: false, error: null,
    ...initialState,
  }
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (partial: Partial<CartState>) => {
      state = { ...state, ...partial }
      for (const l of listeners) l()
    },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
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
  it('returns initial cart state', () => {
    const client = makeClient()
    const { result } = renderHook(() => useCart(), { wrapper: makeWrapper(client) })
    expect(result.current.items).toEqual([])
    expect(result.current.itemCount).toBe(0)
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

  it('exposes addItem from client', async () => {
    const cartStore = makeCartStore()
    const client = makeClient(cartStore)
    const { result } = renderHook(() => useCart(), { wrapper: makeWrapper(client) })
    await act(async () => {
      await result.current.addItem('var-1', 2)
    })
    expect(cartStore.addItem).toHaveBeenCalledWith('var-1', 2)
  })
})
