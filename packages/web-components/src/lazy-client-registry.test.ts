import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import type { CommerceAdapter } from '@nymbalhq/sdk'
import { cards, type CardProduct } from './__fixtures__/server-data.js'

// AC-6: a page's client from `@nymbalhq/sdk/core` holds only the namespaces the page imported, and builds each on its
// first read. registerClient must neither read (build) nor trip over the namespaces, and must still subscribe a store
// built after it, so an element connecting after that store settled shows the store's data over what a server gave it
// (a page restored from the bfcache after the cart or search changed elsewhere).
//
// The setup file registers every element, whose modules import every namespace, so each case starts from a fresh
// module graph: the core, `ns/cart`, and a registry no client was registered with. The element connects with no
// declarative shadow root, so it reads the settled store as it connects (base-element.ts, takeSettledStores).

const BASE = 'https://api.lazy-client.test'

/** An adapter whose search answers `found`; the cart is empty. Nothing else is called. */
function adapterFinding(found: CardProduct[]): CommerceAdapter {
  return {
    cart: {
      get: async () => ({ token: 't', customerId: null, items: [], subtotalMinor: 0, currency: 'GBP' }),
    },
    products: {
      search: async () => ({ items: found, total: found.length, nextCursor: null, facets: [] }),
    },
  } as unknown as CommerceAdapter
}

/** The slugs of the product cards an element renders, in order. */
function slugs(el: Element): string[] {
  if (el.shadowRoot === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return [...el.shadowRoot.querySelectorAll('nymbal-product-card')].map(
    (c) => (JSON.parse(c.getAttribute('product') ?? '{}') as { slug?: string }).slug ?? '',
  )
}

let tags = 0

describe('AC-6: registerClient with a lazily built client', () => {
  it('AC-6: property: with only ns/cart imported, registerClient neither throws nor builds a store; search, built after it, settles on its first update that is not loading, and a search-results element connecting later shows the store’s results over its server’s', async () => {
    await fc.assert(
      fc.asyncProperty(cards('p-', 1), cards('s-', 1), async (server, stored) => {
        vi.resetModules()
        const core = await import('@nymbalhq/sdk/core')
        await import('@nymbalhq/sdk/ns/cart')
        const registry = await import('./registry.js')

        const client = core.createNymbalClient({
          baseUrl: BASE,
          adapter: adapterFinding(stored),
          tokenStorage: 'memory',
        })
        const built: object[] = []
        const stopListening = core.onStoreBuilt(client, (store: object) => {
          built.push(store)
        })
        try {
          registry.registerClient(client)
          expect(built.length, 'stores built by registerClient').toBe(0)

          await import('@nymbalhq/sdk/ns/search')
          const search = client.search
          expect(built.length, 'stores built by reading client.search').toBe(1)
          expect(built[0]).toBe(search)
          expect(registry.hasSettled(search), 'before any update').toBe(false)

          const searching = search.search('wool')
          expect(search.getState().loading).toBe(true)
          expect(registry.hasSettled(search), 'after a loading update').toBe(false)
          await searching
          expect(search.getState().total).toBe(stored.length)
          expect(registry.hasSettled(search), 'after the settled update').toBe(true)

          const { NymbalSearchResults } = await import('./components/search-results.js')
          const tag = `lazy-search-results-${++tags}`
          customElements.define(tag, class extends NymbalSearchResults {})
          const el = document.createElement(tag) as HTMLElement & {
            updateComplete: Promise<unknown>
          }
          el.setAttribute('results', JSON.stringify(server))
          document.body.append(el)
          await el.updateComplete
          expect(slugs(el)).toEqual(stored.map((p) => p.slug))
          el.remove()
        } finally {
          stopListening()
          client.destroy()
        }
      }),
      { numRuns: 5 },
    )
  })
})
