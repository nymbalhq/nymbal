import type { CommerceAdapter } from './adapter/commerce-adapter.js'
import { FetchClient } from './adapter/fetch-client.js'
import { createNymbalApiAdapter } from './adapter/nymbal-api-adapter.js'
import { createTokenManager, type TokenManager } from './auth/token-manager.js'
import type { CartStore } from './store/cart-store.js'
import type { ProductStore } from './store/product-store.js'
import type { ProductListStore } from './store/product-list-store.js'
import type { SearchStore } from './store/search-store.js'
import type { CheckoutStore } from './store/checkout-store.js'
import type { AuthStore } from './store/auth-store.js'
import type { Store } from './store/create-store.js'
import type { CustomerAddress, ShopperOrder, StoreCapabilities } from '@nymbalhq/types'
import type { DenormalisedProduct, NewAddress, OrderPage } from './types.js'

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
    /** `key`, the order's key from its checkout, reads it with no session; without one, only its owner can. */
    get(orderNumber: string, options?: { key?: string }): Promise<ShopperOrder>
  }
}

/**
 * A guest's orders, opened with the key from the checkout or the order email. Once the key has expired, the read is
 * refused with `orders.key_expired` and opens with the order's email beside the key; the email travels in a header,
 * never in a URL.
 */
export interface GuestOrders {
  get(orderNumber: string, options?: { key?: string; email?: string }): Promise<ShopperOrder>
  /** Asks the store to email the order's link to the order's own email; it answers the same whatever matched. */
  requestLink(request: { orderNumber: string; email: string }): Promise<void>
}

/** The store's capabilities report, read once per client: what it can do does not change while it runs. */
export interface StoreCapabilitiesReader {
  get(): Promise<StoreCapabilities>
}

/** The shopper's recently viewed products, kept by the store under the signed-in customer or the browser's visitor. */
export interface RecentlyViewed {
  /** Records a view of the product; the store ignores a product that is not active. */
  record(productId: string): Promise<void>
  /** The shopper's active products, newest first. */
  list(): Promise<{ items: DenormalisedProduct[] }>
}

export interface NymbalClient {
  capabilities: StoreCapabilitiesReader
  recentlyViewed: RecentlyViewed
  cart: CartStore
  product: ProductStore
  productList: ProductListStore
  search: SearchStore
  checkout: CheckoutStore
  auth: AuthStore
  customer: CustomerAccount
  orders: GuestOrders
  adapter: CommerceAdapter
  destroy(): void
}

/** The client's store namespaces, each built on its first read by the factory its `@nymbalhq/sdk/ns/<module>` registers. */
export type StoreNamespace = 'cart' | 'product' | 'productList' | 'search' | 'checkout' | 'auth'

const STORE_NAMESPACES: StoreNamespace[] = [
  'cart',
  'product',
  'productList',
  'search',
  'checkout',
  'auth',
]

/** What a namespace's factory builds its store from: the client's adapter and token manager, and the client itself. */
export interface NamespaceContext {
  adapter: CommerceAdapter
  tokenManager: TokenManager
  client: NymbalClient
}

type NamespaceFactory<K extends StoreNamespace> = (context: NamespaceContext) => NymbalClient[K]

type Factories = { [K in StoreNamespace]?: NamespaceFactory<K> }

// On globalThis, like the payment drivers: a namespace module of one SDK copy registers for a client of another.
const FACTORIES_KEY = Symbol.for('nymbal.sdk.namespaces')

function factories(): Factories {
  const holder = globalThis as Record<symbol, Factories | undefined>
  holder[FACTORIES_KEY] ??= {}
  return holder[FACTORIES_KEY]
}

/** Registers the factory of a store namespace; each `ns` module calls it on import. */
export function defineNamespace<K extends StoreNamespace>(
  name: K,
  factory: NamespaceFactory<K>,
): void {
  factories()[name] = factory as Factories[K]
}

/** What `onStoreBuilt` hands its listener: any store, a hand-made client's included, reads and subscribes. */
type ObservedStore = Pick<Store<unknown>, 'getState' | 'subscribe'>

type ClientStore = ObservedStore & Pick<Store<unknown>, 'destroy'>

type StoreListener = (store: ObservedStore) => void

// On a symbol, not in a module's registry, so a client made by another copy of the SDK still reports its stores.
const STORE_BUILT = Symbol.for('nymbal.client.onStoreBuilt')

type StoreBuiltHook = (listener: StoreListener) => () => void

function isStore(value: unknown): value is ObservedStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ObservedStore).subscribe === 'function' &&
    typeof (value as ObservedStore).getState === 'function'
  )
}

/**
 * Calls `listener` with each store namespace the client has built, and with each it builds later; returns the
 * unsubscribe. A client not made by `createNymbalClient` has its stores already: each is reported once, now.
 */
export function onStoreBuilt(client: NymbalClient, listener: StoreListener): () => void {
  const hook = (client as unknown as Record<symbol, StoreBuiltHook | undefined>)[STORE_BUILT]
  if (typeof hook === 'function') return hook(listener)
  for (const value of Object.values(client)) {
    if (isStore(value)) listener(value)
  }
  return () => {}
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

  const customer: CustomerAccount = {
    addresses: {
      list: () => adapter.customers.listAddresses(),
      create: (address) => adapter.customers.addAddress(address),
      remove: (id) => adapter.customers.removeAddress(id),
    },
    orders: {
      list: (opts) => adapter.customers.listOrders(opts),
      get: (orderNumber, options) => adapter.customers.getOrder(orderNumber, options),
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

  // The adapter is the client's for its whole life, so whether it reads guests' orders is known here.
  const noGuestOrders = () =>
    Promise.reject(new Error('This client’s adapter cannot open a guest’s order.'))
  const orders: GuestOrders = adapter.orders ?? { get: noGuestOrders, requestLink: noGuestOrders }

  const recentlyViewedOf = (): NonNullable<CommerceAdapter['recentlyViewed']> => {
    const reader = adapter.recentlyViewed
    if (reader === undefined) {
      throw new Error('This client’s adapter cannot record or list recently viewed products.')
    }
    return reader
  }
  const recentlyViewed: RecentlyViewed = {
    async record(productId) {
      await recentlyViewedOf().record(productId)
    },
    async list() {
      return recentlyViewedOf().list()
    },
  }

  tokenManager.scheduleRefresh(() => adapter.customers.refresh())

  const built: { [K in StoreNamespace]?: ClientStore } = {}
  const listeners = new Set<StoreListener>()
  let destroyed = false

  function destroy(): void {
    destroyed = true
    for (const store of Object.values(built)) store.destroy()
    tokenManager.destroy()
  }

  const storeBuilt: StoreBuiltHook = (listener) => {
    for (const store of Object.values(built)) listener(store)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const client = Object.defineProperty(
    { capabilities, recentlyViewed, customer, orders, adapter, destroy },
    STORE_BUILT,
    { value: storeBuilt },
  ) as NymbalClient
  const context: NamespaceContext = { adapter, tokenManager, client }

  function build(name: StoreNamespace): ClientStore {
    // Building one now would leave a live store on a client whose destroy() has run.
    if (destroyed) throw new Error(`client.${name} was read after the client was destroyed`)
    const factory = factories()[name] as NamespaceFactory<StoreNamespace> | undefined
    if (factory === undefined) {
      const module = name === 'productList' ? 'product-list' : name
      throw new Error(`client.${name} is not in this client: import '@nymbalhq/sdk/ns/${module}'`)
    }
    const store = (built[name] = factory(context))
    for (const listener of listeners) listener(store)
    return store
  }

  // Defined properties are not enumerable: walking or spreading the client builds no store.
  for (const name of STORE_NAMESPACES) {
    Object.defineProperty(client, name, { get: () => built[name] ?? build(name) })
  }

  return client
}
