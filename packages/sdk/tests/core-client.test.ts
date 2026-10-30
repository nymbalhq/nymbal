import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import type * as CoreModule from '../src/core.js'
import type { NymbalClient } from '../src/index.js'
import { address, listen, missing, STORE_KEYS, type Listened, type StoreKey } from './namespaces.js'
import { cartItem, defaultData, stubAdapter } from './stub-adapter.js'

// AC-2: a client from the core builds a store namespace on its first read, once, and only when the namespace's module
// was imported; destroy() destroys what was built and builds nothing. Namespace modules register on import into a
// registry on globalThis, shared by every copy of the SDK, so each case empties it and starts from a fresh module graph
// holding only the modules it imports.

type Core = typeof CoreModule

const LOAD: Record<StoreKey, () => Promise<unknown>> = {
  cart: () => import('../src/ns/cart.js'),
  product: () => import('../src/ns/product.js'),
  productList: () => import('../src/ns/product-list.js'),
  search: () => import('../src/ns/search.js'),
  checkout: () => import('../src/ns/checkout.js'),
  auth: () => import('../src/ns/auth.js'),
}

const BASE = 'https://api.core-client.test'

const NAMESPACES = Symbol.for('nymbal.sdk.namespaces')

const itemCount = (items: Array<{ qty: number }>): number =>
  items.reduce((sum, item) => sum + item.qty, 0)

/** The core in a fresh module graph, with only `imported`'s namespace modules loaded. */
async function freshCore(imported: readonly StoreKey[]): Promise<Core> {
  vi.resetModules()
  delete (globalThis as Record<symbol, unknown>)[NAMESPACES]
  const core = await import('../src/core.js')
  for (const key of imported) await LOAD[key]()
  return core
}

/** Reads `key` from the client and starts listening to the store it returns. */
function readAndListen(client: NymbalClient, key: StoreKey): { store: object; listened: Listened } {
  switch (key) {
    case 'cart':
      return { store: client.cart, listened: listen('cart', client.cart) }
    case 'product':
      return { store: client.product, listened: listen('product', client.product) }
    case 'productList':
      return { store: client.productList, listened: listen('productList', client.productList) }
    case 'search':
      return { store: client.search, listened: listen('search', client.search) }
    case 'checkout':
      return { store: client.checkout, listened: listen('checkout', client.checkout) }
    case 'auth':
      return { store: client.auth, listened: listen('auth', client.auth) }
  }
}

describe('AC-2: a core client builds what it is asked for', () => {
  it('AC-2: property: over generated imports and reads, an unimported namespace throws naming its import, an imported one is built once on its first read, and destroy() destroys exactly the namespaces built', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(STORE_KEYS),
        fc.array(fc.constantFrom(...STORE_KEYS), { maxLength: 12 }),
        async (imported, reads) => {
          const core = await freshCore(imported)
          // `ns/checkout` imports `ns/cart`: one cart per client.
          const registered = new Set<StoreKey>(
            imported.includes('checkout') ? [...imported, 'cart'] : imported,
          )
          const client = core.createNymbalClient({
            baseUrl: BASE,
            adapter: stubAdapter(),
            tokenStorage: 'memory',
          })
          const built: object[] = []
          const stopListening = core.onStoreBuilt(client, (store: object) => {
            built.push(store)
          })
          const first = new Map<StoreKey, { store: object; listened: Listened }>()
          try {
            /** Each read in order: the store it returned, or the message it threw. */
            const outcomes = reads.map((key) => {
              try {
                const seen = first.get(key)
                if (seen !== undefined) return { key, store: client[key] as object, again: seen.store }
                const read = readAndListen(client, key)
                first.set(key, read)
                return { key, store: read.store, again: read.store }
              } catch (error) {
                return { key, thrown: error instanceof Error ? error.message : String(error) }
              }
            })
            const unimported = outcomes.filter((o) => !registered.has(o.key))
            expect(unimported.map((o) => o.thrown)).toEqual(unimported.map((o) => missing(o.key)))
            const available = outcomes.filter((o) => registered.has(o.key))
            expect(available.map((o) => o.thrown), 'reads of an imported namespace').toEqual(
              available.map(() => undefined),
            )
            expect(
              available.filter((o) => o.store !== o.again).map((o) => o.key),
              'reads that returned another instance than the first',
            ).toEqual([])

            // The checkout is built on client.cart: reading the cart now returns the one it took.
            if (first.has('checkout') && !first.has('cart')) {
              first.set('cart', readAndListen(client, 'cart'))
            }

            const expected = [...first.values()].map((f) => f.store)
            expect(built.length, 'stores the client reported built').toBe(expected.length)
            expect(new Set(built).size, 'each built store reported once').toBe(built.length)
            expect(built.filter((store) => !expected.includes(store))).toEqual([])

            // Each built store hears its own update before destroy() and none after it.
            for (const [key, { listened }] of first) {
              const before = listened.heard()
              await listened.poke()
              expect(listened.heard(), `${key} before destroy()`).toBeGreaterThan(before)
            }
            client.destroy()
            expect(built.length, 'stores built by destroy()').toBe(expected.length)
            const unbuilt = STORE_KEYS.filter((key) => !first.has(key))
            const readAfterDestroy = unbuilt.map((key) => {
              try {
                void client[key]
                return undefined
              } catch (error) {
                return error instanceof Error ? error.message : String(error)
              }
            })
            expect(readAfterDestroy, 'reads of an unbuilt namespace after destroy()').toEqual(
              unbuilt.map((key) => `client.${key} was read after the client was destroyed`),
            )
            expect(built.length, 'stores built by a read after destroy()').toBe(expected.length)
            for (const [key, { listened }] of first) {
              const before = listened.heard()
              await listened.poke()
              expect(listened.heard(), `${key} after destroy()`).toBe(before)
            }
          } finally {
            stopListening()
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-2: a namespace module imported by one copy of the SDK registers for a client made by another', async () => {
    const first = await freshCore(['cart'])
    vi.resetModules()
    const second = await import('../src/core.js')
    expect(second, 'a second module instance of the core').not.toBe(first)
    const client = second.createNymbalClient({
      baseUrl: BASE,
      adapter: stubAdapter(),
      tokenStorage: 'memory',
    })
    try {
      const { listened } = readAndListen(client, 'cart')
      const before = listened.heard()
      await listened.poke()
      expect(listened.heard()).toBeGreaterThan(before)
      expect(() => client.search).toThrow(missing('search'))
    } finally {
      client.destroy()
    }
  })

  it('AC-2: property: client.checkout places its order on client.cart, whichever of the two is read first', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        async (quantities, cartFirst) => {
          const core = await freshCore(['checkout'])
          const data = defaultData()
          data.cartItems = quantities.map((qty, i) => cartItem(`v${i}`, qty))
          const client = core.createNymbalClient({
            baseUrl: BASE,
            adapter: stubAdapter(data),
            tokenStorage: 'memory',
          })
          try {
            const order: StoreKey[] = cartFirst ? ['cart', 'checkout'] : ['checkout', 'cart']
            for (const key of order) void client[key]
            await client.cart.load()
            expect(client.cart.getState().itemCount).toBe(itemCount(data.cartItems))

            // Confirmed: the server empties the cart, and the checkout loads its cart again.
            data.cartItems = []
            client.checkout.setEmail('buyer@sdk.test')
            client.checkout.setShippingAddress(address)
            client.checkout.setBillingAddress(address)
            await client.checkout.submitPayment()
            expect(client.checkout.getState().paymentStatus).toBe('succeeded')
            expect(client.cart.getState().itemCount).toBe(itemCount(data.cartItems))
          } finally {
            client.destroy()
          }
        },
      ),
      { numRuns: 20 },
    )
  })
})
