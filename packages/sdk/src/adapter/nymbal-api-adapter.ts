import type {
  Cart,
  Customer,
  CustomerAddress,
  Order,
  ReviewsResult,
  ReviewResult,
  StoreCapabilities,
} from '@nymbalhq/types'
import type { CommerceAdapter } from './commerce-adapter.js'
import type { FetchClient } from './fetch-client.js'
import type {
  DenormalisedProduct,
  ProductListParams,
  ProductListResult,
  CheckoutDetails,
  CheckoutResult,
  RegisterParams,
  AuthResult,
  NewAddress,
  OrderPage,
} from '../types.js'

export function createNymbalApiAdapter(fetchClient: FetchClient): CommerceAdapter {
  return {
    capabilities: {
      get() {
        return fetchClient.request<StoreCapabilities>('GET', '/api/capabilities')
      },
    },

    cart: {
      get() {
        return fetchClient.request<Cart>('GET', '/api/cart')
      },
      addItem(variantId: string, qty: number) {
        return fetchClient.request<Cart>('POST', '/api/cart/items', { variantId, qty })
      },
      removeItem(variantId: string) {
        return fetchClient.request<Cart>(
          'DELETE',
          `/api/cart/items/${encodeURIComponent(variantId)}`,
        )
      },
      updateQuantity(variantId: string, qty: number) {
        return fetchClient.request<Cart>(
          'PATCH',
          `/api/cart/items/${encodeURIComponent(variantId)}`,
          { qty },
        )
      },
      clear() {
        return fetchClient.request<Cart>('DELETE', '/api/cart')
      },
    },

    products: {
      getBySlug(slug: string) {
        return fetchClient.request<DenormalisedProduct>(
          'GET',
          `/api/products/${encodeURIComponent(slug)}`,
        )
      },
      list(params?: ProductListParams) {
        const search = new URLSearchParams()
        if (params?.limit !== undefined) search.set('limit', String(params.limit))
        if (params?.cursor !== undefined) search.set('cursor', params.cursor)
        if (params?.category !== undefined) search.set('category', params.category)
        if (params?.sort !== undefined) search.set('sort', params.sort)
        const qs = search.toString()
        return fetchClient.request<ProductListResult>('GET', `/api/products${qs ? `?${qs}` : ''}`)
      },
      search(query: string, params?: { limit?: number; cursor?: string }) {
        const search = new URLSearchParams()
        search.set('q', query)
        if (params?.limit !== undefined) search.set('limit', String(params.limit))
        if (params?.cursor !== undefined) search.set('cursor', params.cursor)
        return fetchClient.request<ProductListResult>(
          'GET',
          `/api/products/search?${search.toString()}`,
        )
      },
    },

    checkout: {
      create(details: CheckoutDetails) {
        return fetchClient.request<CheckoutResult>('POST', '/api/checkout', details)
      },
    },

    customers: {
      register(params: RegisterParams) {
        return fetchClient.request<AuthResult>('POST', '/api/auth/register', params)
      },
      login(email: string, password: string) {
        return fetchClient.request<AuthResult>('POST', '/api/auth/login', { email, password })
      },
      async logout() {
        await fetchClient.request<{ ok: boolean }>('POST', '/api/auth/logout')
      },
      refresh() {
        return fetchClient.request<{ accessToken: string; expiresIn: number }>(
          'POST',
          '/api/auth/refresh',
        )
      },
      getProfile() {
        return fetchClient.request<Customer>('GET', '/api/customers/me')
      },
      updateProfile(updates: Partial<Pick<Customer, 'firstName' | 'lastName' | 'phone'>>) {
        return fetchClient.request<Customer>('PATCH', '/api/customers/me', updates)
      },
      listAddresses() {
        return fetchClient.request<CustomerAddress[]>('GET', '/api/customers/me/addresses')
      },
      addAddress(address: NewAddress) {
        return fetchClient.request<CustomerAddress>('POST', '/api/customers/me/addresses', address)
      },
      async removeAddress(id: string) {
        await fetchClient.request<{ ok: boolean }>(
          'DELETE',
          `/api/customers/me/addresses/${encodeURIComponent(id)}`,
        )
      },
      async listOrders(params?: { cursor?: string }): Promise<OrderPage> {
        const qs =
          params?.cursor !== undefined ? `?cursor=${encodeURIComponent(params.cursor)}` : ''
        const { data, meta } = await fetchClient.requestWithMeta<Order[]>('GET', `/api/orders${qs}`)
        const nextCursor = typeof meta.nextCursor === 'string' ? meta.nextCursor : null
        return { items: data ?? [], nextCursor }
      },
      getOrder(orderNumber: string) {
        return fetchClient.request<Order>('GET', `/api/orders/${encodeURIComponent(orderNumber)}`)
      },
    },

    reviews: {
      getForProduct(productId: string, params?: { limit?: number; cursor?: string }) {
        const search = new URLSearchParams()
        if (params?.limit !== undefined) search.set('limit', String(params.limit))
        if (params?.cursor !== undefined) search.set('cursor', params.cursor)
        const qs = search.toString()
        return fetchClient.request<ReviewsResult>(
          'GET',
          `/api/products/${encodeURIComponent(productId)}/reviews${qs ? `?${qs}` : ''}`,
        )
      },
      submit(review: { productId: string; rating: number; title: string; body: string }) {
        return fetchClient.request<ReviewResult>('POST', '/api/reviews', review)
      },
    },
  }
}
