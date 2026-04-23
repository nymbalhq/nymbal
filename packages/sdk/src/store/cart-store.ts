import type { CartItem } from '@nymbal/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { CartState } from '../types.js'
import { createStore } from './create-store.js'

function deriveItemCount(items: CartItem[]): number {
  let count = 0
  for (const item of items) {
    count += item.qty
  }
  return count
}

const INITIAL_STATE: CartState = {
  items: [],
  subtotalMinor: 0,
  currency: 'USD',
  itemCount: 0,
  loading: false,
  error: null,
}

export interface CartStore {
  getState(): CartState
  subscribe(listener: () => void): () => void
  addItem(variantId: string, qty?: number): Promise<void>
  removeItem(variantId: string): Promise<void>
  updateQuantity(variantId: string, qty: number): Promise<void>
  clear(): Promise<void>
  load(): Promise<void>
  destroy(): void
}

export function createCartStore(adapter: CommerceAdapter): CartStore {
  const store = createStore<CartState>(INITIAL_STATE)

  async function load(): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      const cart = await adapter.cart.get()
      store.setState({
        items: cart.items,
        subtotalMinor: cart.subtotalMinor,
        currency: cart.currency,
        itemCount: deriveItemCount(cart.items),
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function addItem(variantId: string, qty = 1): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      const cart = await adapter.cart.addItem(variantId, qty)
      store.setState({
        items: cart.items,
        subtotalMinor: cart.subtotalMinor,
        currency: cart.currency,
        itemCount: deriveItemCount(cart.items),
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function removeItem(variantId: string): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      const cart = await adapter.cart.removeItem(variantId)
      store.setState({
        items: cart.items,
        subtotalMinor: cart.subtotalMinor,
        currency: cart.currency,
        itemCount: deriveItemCount(cart.items),
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function updateQuantity(variantId: string, qty: number): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      const cart = await adapter.cart.updateQuantity(variantId, qty)
      store.setState({
        items: cart.items,
        subtotalMinor: cart.subtotalMinor,
        currency: cart.currency,
        itemCount: deriveItemCount(cart.items),
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function clear(): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      await adapter.cart.clear()
      store.setState({
        items: [],
        subtotalMinor: 0,
        itemCount: 0,
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    addItem,
    removeItem,
    updateQuantity,
    clear,
    load,
    destroy: store.destroy,
  }
}
