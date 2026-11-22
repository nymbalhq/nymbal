import type { CartState, NymbalClient } from '@nymbalhq/sdk'
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
  const cartStore = createMockStore<CartState>({
    items: [],
    subtotalMinor: 0,
    currency: 'GBP',
    itemCount: 0,
    totals: null,
    promotions: { codes: [], unavailable: false },
    loading: false,
    error: null,
    errorCode: null,
  })
  const productStore = createMockStore({ product: null, selectedVariant: null, loading: false, error: null })
  const searchStore = createMockStore({
    query: '',
    category: null,
    results: [],
    total: 0,
    nextCursor: null,
    facets: [],
    loading: false,
  })
  const productListStore = createMockStore({ products: [], facets: [], filters: {}, sort: 'newest' as const, pagination: { cursor: null, hasMore: false }, loading: false, error: null })
  const authStore = createMockStore({ customer: null, isAuthenticated: false, loading: false, error: null })
  const checkoutStore = createMockStore({ step: 'contact' as const, email: '', shippingAddress: null, billingAddress: null, quote: null, quoting: false, paymentStatus: 'idle' as const, error: null, errorCode: null, order: null, placedOrderNumber: null, placedOrderKey: null })

  return {
    cart: {
      ...cartStore,
      addItem: async () => {},
      removeItem: async () => {},
      updateQuantity: async () => {},
      clear: async () => {},
      load: async () => {},
      addCode: async () => {},
      removeCode: async () => {},
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
      loadMore: async () => {},
      setCategory: async () => {},
      clearSearch: () => {},
    },
    auth: {
      ...authStore,
      login: async () => {},
      register: async () => 'signed-in' as const,
      requestPasswordReset: async () => {},
      resetPassword: async () => {},
      verifyEmail: async () => {},
      resendVerification: async () => {},
      changePassword: async () => {},
      logout: async () => {},
      refreshToken: async () => {},
      updateProfile: async () => {},
      loadProfile: async () => {},
      restore: async () => {},
    },
    checkout: {
      ...checkoutStore,
      setEmail: () => {},
      setShippingAddress: () => {},
      setBillingAddress: () => {},
      quote: async () => null,
      selectShippingOption: async () => null,
      submitPayment: async () => {},
      reset: () => {},
    },
    recentlyViewed: {
      record: async () => {},
      list: async () => ({ items: [] }),
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
