import { describe, expect, it } from 'vitest'
import { onStoreBuilt } from '../src/core.js'
import { createNymbalClient } from '../src/index.js'
import { listen, STORE_KEYS, type Listened } from './namespaces.js'
import { cartItem, defaultData, product, stubAdapter } from './stub-adapter.js'

// AC-3: `@nymbalhq/sdk` gives the whole client with no further import, as before the core and its namespace modules:
// each of the six stores, customer, capabilities, orders, recentlyViewed and adapter answer from the client's adapter,
// and destroy() stops them. Its client is a core client, so `onStoreBuilt` (what `registerClient` subscribes through,
// Next's template included) reports each store it builds.

const BASE = 'https://api.full-client.test'

const itemCount = (items: Array<{ qty: number }>): number =>
  items.reduce((sum, item) => sum + item.qty, 0)

describe('AC-3: the full entry has every namespace', () => {
  it('AC-3: a client from @nymbalhq/sdk loads each of its six stores, customer, capabilities, orders and recentlyViewed from its adapter, and onStoreBuilt reports each store once', async () => {
    const data = defaultData()
    data.cartItems = [cartItem('v1', 2), cartItem('v2', 3)]
    data.viewed = [product('seen-1'), product('seen-2')]
    const adapter = stubAdapter(data)
    const client = createNymbalClient({ baseUrl: BASE, adapter, tokenStorage: 'memory' })
    const built: object[] = []
    const stopListening = onStoreBuilt(client, (store: object) => {
      built.push(store)
    })
    try {
      await client.cart.load()
      expect(client.cart.getState().itemCount).toBe(itemCount(data.cartItems))

      await client.product.loadBySlug(data.product.slug)
      expect(client.product.getState().product?.slug).toBe(data.product.slug)

      await client.productList.load()
      expect(client.productList.getState().products.map((p) => p.slug)).toEqual(
        data.listed.map((p) => p.slug),
      )

      await client.search.search('wool')
      expect(client.search.getState().total).toBe(data.found.length)

      await client.auth.login(data.customer.email, 'correct-horse')
      expect(client.auth.getState().customer?.email).toBe(data.customer.email)

      client.checkout.setEmail(data.customer.email)
      expect(client.checkout.getState().email).toBe(client.auth.getState().customer?.email)

      expect(await client.customer.addresses.list()).toBe(data.addresses)
      expect(await client.capabilities.get()).toBe(data.capabilities)
      expect(await client.orders.get(data.order.orderNumber)).toBe(data.order)
      expect((await client.recentlyViewed.list()).items.map((p) => p.slug)).toEqual(
        data.viewed.map((p) => p.slug),
      )
      expect(client.adapter).toBe(adapter)

      const stores = STORE_KEYS.map((key) => client[key])
      expect(built.length).toBe(stores.length)
      expect(stores.filter((store) => !built.includes(store))).toEqual([])
    } finally {
      stopListening()
      client.destroy()
    }
  })

  it('AC-3: destroy() on a client from @nymbalhq/sdk stops every one of its six stores', async () => {
    const client = createNymbalClient({
      baseUrl: BASE,
      adapter: stubAdapter(),
      tokenStorage: 'memory',
    })
    const listened: Array<[string, Listened]> = [
      ['cart', listen('cart', client.cart)],
      ['product', listen('product', client.product)],
      ['productList', listen('productList', client.productList)],
      ['search', listen('search', client.search)],
      ['checkout', listen('checkout', client.checkout)],
      ['auth', listen('auth', client.auth)],
    ]
    expect(listened.map(([key]) => key)).toEqual(STORE_KEYS)
    for (const [key, store] of listened) {
      const before = store.heard()
      await store.poke()
      expect(store.heard(), `${key} before destroy()`).toBeGreaterThan(before)
    }
    client.destroy()
    for (const [key, store] of listened) {
      const before = store.heard()
      await store.poke()
      expect(store.heard(), `${key} after destroy()`).toBe(before)
    }
  })
})
