import type { CommerceAdapter } from './adapter/commerce-adapter.js'
import { FetchClient } from './adapter/fetch-client.js'
import { createNymbalApiAdapter } from './adapter/nymbal-api-adapter.js'
import { createTokenManager } from './auth/token-manager.js'
import { createCartStore, type CartStore } from './store/cart-store.js'
import { createProductStore, type ProductStore } from './store/product-store.js'
import { createProductListStore, type ProductListStore } from './store/product-list-store.js'
import { createSearchStore, type SearchStore } from './store/search-store.js'
import { createCheckoutStore, type CheckoutStore } from './store/checkout-store.js'
import { createAuthStore, type AuthStore } from './store/auth-store.js'
import type { CustomerAddress, Order, StoreCapabilities } from '@nymbalhq/types'
import type { NewAddress, OrderPage } from './types.js'

export interface NymbalClientOptions {
  baseUrl: string
  adapter?: CommerceAdapter
  tokenStorage?: 'memory' | 'localStorage'
  credentials?: RequestCredentials
  getCartToken?: () => string | null
}

/** The signed-in customer's own account; every call sends the session's bearer token. */
export interface CustomerAccount {
  addresses: {
    list(): Promise<CustomerAddress[]>
    create(address: NewAddress): Promise<CustomerAddress>
    remove(id: string): Promise<void>
  }
  orders: {
    list(opts?: { cursor?: string }): Promise<OrderPage>
    get(orderNumber: string): Promise<Order>
  }
}

/** The store's capabilities report, read once per client: what it can do does not change while it runs. */
export interface StoreCapabilitiesReader {
  get(): Promise<StoreCapabilities>
}

export interface NymbalClient {
  capabilities: StoreCapabilitiesReader
  cart: CartStore
  product: ProductStore
  productList: ProductListStore
  search: SearchStore
  checkout: CheckoutStore
  auth: AuthStore
  customer: CustomerAccount
  adapter: CommerceAdapter
  destroy(): void
}

export function createNymbalClient(options: NymbalClientOptions): NymbalClient {
  const tokenManager = createTokenManager({
    ...(options.tokenStorage !== undefined && { storage: options.tokenStorage }),
  })

  let adapter: CommerceAdapter

  if (options.adapter) {
    adapter = options.adapter
  } else {
    const fetchClient = new FetchClient({
      baseUrl: options.baseUrl,
      ...(options.credentials !== undefined && { credentials: options.credentials }),
      getAccessToken: () => tokenManager.getAccessToken(),
      ...(options.getCartToken !== undefined && { getCartToken: options.getCartToken }),
      onUnauthorized: async () => {
        try {
          const result = await adapter.customers.refresh()
          tokenManager.setTokens(result.accessToken, result.expiresIn)
        } catch (err) {
          // Token refresh failure is expected when the user session has expired.
          console.warn('[NymbalClient] token refresh on unauthorized failed', err)
          tokenManager.clear()
        }
      },
    })
    adapter = createNymbalApiAdapter(fetchClient)
  }

  const cart = createCartStore(adapter)
  const product = createProductStore(adapter)
  const productList = createProductListStore(adapter)
  const search = createSearchStore(adapter)
  const checkout = createCheckoutStore(adapter, cart)
  const auth = createAuthStore(adapter, tokenManager)

  const customer: CustomerAccount = {
    addresses: {
      list: () => adapter.customers.listAddresses(),
      create: (address) => adapter.customers.addAddress(address),
      remove: (id) => adapter.customers.removeAddress(id),
    },
    orders: {
      list: (opts) => adapter.customers.listOrders(opts),
      get: (orderNumber) => adapter.customers.getOrder(orderNumber),
    },
  }

  // A failed read is not kept, so the next get() asks again.
  let report: Promise<StoreCapabilities> | null = null
  const capabilities: StoreCapabilitiesReader = {
    get() {
      if (report === null) {
        const reader = adapter.capabilities
        report =
          reader === undefined
            ? Promise.reject(new Error('This client’s adapter cannot read the store capabilities.'))
            : reader.get()
        report.catch(() => {
          report = null
        })
      }
      return report
    },
  }

  tokenManager.scheduleRefresh(() => adapter.customers.refresh())

  function destroy(): void {
    cart.destroy()
    product.destroy()
    productList.destroy()
    search.destroy()
    checkout.destroy()
    auth.destroy()
    tokenManager.destroy()
  }

  return {
    capabilities,
    cart,
    product,
    productList,
    search,
    checkout,
    auth,
    customer,
    adapter,
    destroy,
  }
}
