import type { NymbalClient } from '@nymbal/sdk'
import { registerClient } from '../registry.js'

export function createMockStore<S>(initialState: S) {
  let state = initialState
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (partial: Partial<S>) => {
      state = { ...state, ...partial }
      for (const l of listeners) l()
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    destroy: () => { listeners.clear() },
  }
}

export function createMockClient(): NymbalClient {
  const cartStore = createMockStore({
    items: [],
    subtotalMinor: 0,
    currency: 'GBP',
    itemCount: 0,
    loading: false,
    error: null,
  })
  const productStore = createMockStore({ product: null, selectedVariant: null, loading: false, error: null })
  const searchStore = createMockStore({ query: '', results: [], total: 0, loading: false })
  const productListStore = createMockStore({ products: [], facets: [], filters: {}, sort: null, pagination: { cursor: null, hasMore: false }, loading: false, error: null })
  const authStore = createMockStore({ customer: null, isAuthenticated: false, loading: false, error: null })
  const checkoutStore = createMockStore({ step: 'contact' as const, email: '', shippingAddress: null, billingAddress: null, shippingMethod: null, paymentStatus: 'idle' as const, error: null, order: null })

  return {
    cart: {
      ...cartStore,
      addItem: async () => {},
      removeItem: async () => {},
      updateQuantity: async () => {},
      clear: async () => {},
      load: async () => {},
    },
    product: {
      ...productStore,
      loadBySlug: async () => {},
      selectVariant: () => {},
    },
    productList: {
      ...productListStore,
      load: async () => {},
      loadMore: async () => {},
      applyFilter: async () => {},
      removeFilter: async () => {},
      setSort: async () => {},
    },
    search: {
      ...searchStore,
      search: async () => {},
      clearSearch: () => {},
    },
    auth: {
      ...authStore,
      login: async () => {},
      register: async () => {},
      logout: async () => {},
      refreshToken: async () => {},
      updateProfile: async () => {},
      loadProfile: async () => {},
    },
    checkout: {
      ...checkoutStore,
      setEmail: () => {},
      setShippingAddress: () => {},
      setBillingAddress: () => {},
      setShippingMethod: () => {},
      submitPayment: async () => {},
      reset: () => {},
    },
  } as unknown as NymbalClient
}

let _mockClient: NymbalClient | null = null

export function setupMockClient(): NymbalClient {
  _mockClient = createMockClient()
  registerClient(_mockClient)
  return _mockClient
}

export function resetMockClient(): void {
  _mockClient = null
}
