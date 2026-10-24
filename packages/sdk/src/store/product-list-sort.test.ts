import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProductSortKey } from '@nymbalhq/types'
import { createNymbalClient } from '../client.js'

// AC-6: the product list sends the active sort and the active category on every request it makes, however the
// category was set (Astro's `applyFilter`, Next's `load({ category })`), and `loadMore` keeps both next to its cursor.

const BASE = 'https://api.sort.test'
const KEYS: ProductSortKey[] = ['newest', 'price-asc', 'price-desc', 'name-asc', 'name-desc']
const FIRST_CURSOR = 'cursor-after-page-1'

function item(slug: string) {
  return {
    id: slug,
    slug,
    name: slug,
    description: '',
    shortDescription: '',
    status: 'active',
    type: 'simple',
    media: [],
    variantCount: 1,
    inStock: true,
    priceRange: { minMinor: 100, maxMinor: 100 },
    priceMinor: 100,
    currency: 'GBP',
    variants: [],
    categoryIds: [],
    categories: [],
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  }
}

/** A fake API: records the query of every `GET /api/products`; page 1 has a next cursor, the page after it has none. */
function fakeApi() {
  const lists: URLSearchParams[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname !== '/api/products') {
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }
    lists.push(url.searchParams)
    const paged = url.searchParams.has('cursor')
    const data = paged
      ? { items: [item('second')], nextCursor: null, facets: [] }
      : { items: [item('first')], nextCursor: FIRST_CURSOR, facets: [] }
    return new Response(JSON.stringify({ data }), { status: 200 })
  })
  return { lists }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('product list sort', () => {
  it('AC-6: setSort(key) requests sort=<key> with the active category, and loadMore keeps both beside the cursor', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KEYS),
        fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
        fc.constantFrom('applyFilter' as const, 'load' as const),
        async (key, category, entry) => {
          const api = fakeApi()
          const client = createNymbalClient({ baseUrl: BASE, tokenStorage: 'memory' })
          try {
            if (entry === 'applyFilter') await client.productList.applyFilter('category', category)
            else await client.productList.load({ limit: 24, category })

            await client.productList.setSort(key)
            const sorted = api.lists.at(-1)!
            expect(sorted.get('sort')).toBe(key)
            expect(sorted.get('category')).toBe(category)
            expect(client.productList.getState().sort).toBe(key)

            const before = api.lists.length
            await client.productList.loadMore()
            expect(api.lists.length).toBe(before + 1)
            const more = api.lists.at(-1)!
            expect(more.get('cursor')).toBe(FIRST_CURSOR)
            expect(more.get('sort')).toBe(key)
            expect(more.get('category')).toBe(category)
            expect(client.productList.getState().products.map((p) => p.slug)).toEqual([
              'first',
              'second',
            ])
          } finally {
            client.destroy()
            vi.unstubAllGlobals()
          }
        },
      ),
      { numRuns: 40 },
    )
  })

  it('AC-6: products.list sends ProductListParams.sort in the query string', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...KEYS), async (key) => {
        const api = fakeApi()
        const client = createNymbalClient({ baseUrl: BASE, tokenStorage: 'memory' })
        try {
          await client.adapter.products.list({ limit: 3, sort: key })
          expect(api.lists.at(-1)!.get('sort')).toBe(key)
        } finally {
          client.destroy()
          vi.unstubAllGlobals()
        }
      }),
      { numRuns: 10 },
    )
  })
})
