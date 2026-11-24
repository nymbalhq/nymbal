import type { CartItem, ShopperCart } from '@nymbalhq/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import { NymbalApiError } from '../adapter/fetch-client.js'
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
  totals: null,
  promotions: { codes: [], unavailable: false },
  loading: false,
  error: null,
  errorCode: null,
}

export interface CartStore {
  getState(): CartState
  subscribe(listener: () => void): () => void
  addItem(variantId: string, qty?: number): Promise<void>
  removeItem(variantId: string): Promise<void>
  updateQuantity(variantId: string, qty: number): Promise<void>
  clear(): Promise<void>
  load(): Promise<void>
  /** Adds a discount code, trimmed; a blank one asks nothing. A refusal sets `error` and `errorCode`. */
  addCode(code: string): Promise<void>
  removeCode(code: string): Promise<void>
  destroy(): void
}

export function createCartStore(adapter: CommerceAdapter): CartStore {
  const store = createStore<CartState>(INITIAL_STATE)

  /** One cart call: the state becomes the API's answer, or keeps the cart and says why the call was refused. */
  async function run(call: () => Promise<ShopperCart>): Promise<void> {
    store.setState({ loading: true, error: null, errorCode: null })
    try {
      const cart = await call()
      store.setState({
        items: cart.items,
        subtotalMinor: cart.subtotalMinor,
        currency: cart.currency,
        itemCount: deriveItemCount(cart.items),
        totals: cart.totals,
        promotions: cart.promotions,
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        errorCode: err instanceof NymbalApiError ? err.code : null,
      })
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    addItem: (variantId, qty = 1) => run(() => adapter.cart.addItem(variantId, qty)),
    removeItem: (variantId) => run(() => adapter.cart.removeItem(variantId)),
    updateQuantity: (variantId, qty) => run(() => adapter.cart.updateQuantity(variantId, qty)),
    clear: () => run(() => adapter.cart.clear()),
    load: () => run(() => adapter.cart.get()),
    async addCode(code) {
      const trimmed = code.trim()
      if (trimmed === '') return
      return run(() => adapter.cart.addCode(trimmed))
    },
    removeCode: (code) => run(() => adapter.cart.removeCode(code)),
    destroy: store.destroy,
  }
}
