import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ProductSortKey } from '@nymbalhq/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { DenormalisedProduct, ProductListParams, ProductListResult } from '../types.js'
import { createProductListStore } from './product-list-store.js'

// P1-11 diff review M2: the product list keeps only the answer to its latest request. A response that arrives after a
// newer request was made (a `newest` page answered after `setSort('price-desc')`, a "load more" page answered after
// the sort changed) is dropped: it must not replace the products, set the sort or leave its cursor, which the next
// "load more" would send beside the new sort (the API answers 400).
// Kills: `load` and `loadMore` applying every response they await, in whatever order the responses arrive.

const KEYS: ProductSortKey[] = ['newest', 'price-asc', 'price-desc', 'name-asc', 'name-desc']

interface Pending {
  params: ProductListParams | undefined
  resolve(result: ProductListResult): void
}

/** An adapter whose `products.list` answers only when the test resolves that call. */
function deferredAdapter(): { adapter: CommerceAdapter; calls: Pending[] } {
  const calls: Pending[] = []
  const adapter = {
    products: {
      list(params?: ProductListParams): Promise<ProductListResult> {
        return new Promise((resolve) => calls.push({ params, resolve }))
      },
    },
  } as unknown as CommerceAdapter
  return { adapter, calls }
}

function page(slugs: string[], nextCursor: string | null): ProductListResult {
  return {
    items: slugs.map((slug) => ({ id: slug, slug, name: slug }) as unknown as DenormalisedProduct),
    nextCursor,
    facets: [],
  }
}

const slugsOf = (products: DenormalisedProduct[]) => products.map((p) => p.slug)

/** Two different sort keys, and a page of distinct slugs (with a cursor) for each of three responses. */
const scenario = fc.record({
  keys: fc
    .tuple(fc.constantFrom(...KEYS), fc.constantFrom(...KEYS))
    .filter(([first, second]) => first !== second),
  slugs: fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), {
    minLength: 3,
    maxLength: 12,
  }),
  cursors: fc.uniqueArray(fc.stringMatching(/^c[a-z0-9]{1,8}$/), {
    minLength: 3,
    maxLength: 3,
  }),
})

/** Splits the slugs into three non-empty, disjoint pages. */
function threePages(slugs: string[]): [string[], string[], string[]] {
  const third = Math.max(1, Math.floor(slugs.length / 3))
  return [slugs.slice(0, third), slugs.slice(third, 2 * third), slugs.slice(2 * third)]
}

describe('product list: out-of-order responses (P1-11 review M2)', () => {
  it('M2: a stale load response arriving after setSort’s leaves the products, sort and cursor of setSort’s response', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ keys: [first, second], slugs, cursors }) => {
        const [stalePage, freshPage] = threePages(slugs)
        const [staleCursor, freshCursor] = cursors as [string, string, string]
        const { adapter, calls } = deferredAdapter()
        const store = createProductListStore(adapter)
        try {
          const stale = store.load({ sort: first })
          const fresh = store.setSort(second)
          expect(calls.map((c) => c.params?.sort)).toEqual([first, second])

          calls[1]!.resolve(page(freshPage, freshCursor))
          await fresh
          calls[0]!.resolve(page(stalePage, staleCursor))
          await stale

          const state = store.getState()
          expect(slugsOf(state.products)).toEqual(freshPage)
          expect(state.sort).toBe(second)
          expect(state.pagination.cursor).toBe(freshCursor)
          expect(state.pagination.hasMore).toBe(true)
          expect(state.loading).toBe(false)
        } finally {
          store.destroy()
        }
      }),
      { numRuns: 50 },
    )
  })

  it('M2: a loadMore response arriving after setSort’s is not appended to the new list and does not leave its cursor', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ keys: [first, second], slugs, cursors }) => {
        const [firstPage, morePage, sortedPage] = threePages(slugs)
        const [firstCursor, moreCursor, sortedCursor] = cursors as [string, string, string]
        const { adapter, calls } = deferredAdapter()
        const store = createProductListStore(adapter)
        try {
          const loaded = store.load({ sort: first })
          calls[0]!.resolve(page(firstPage, firstCursor))
          await loaded

          const more = store.loadMore()
          const sorted = store.setSort(second)
          expect(calls.map((c) => [c.params?.sort, c.params?.cursor])).toEqual([
            [first, undefined],
            [first, firstCursor],
            [second, undefined],
          ])

          calls[2]!.resolve(page(sortedPage, sortedCursor))
          await sorted
          calls[1]!.resolve(page(morePage, moreCursor))
          await more

          const state = store.getState()
          expect(slugsOf(state.products)).toEqual(sortedPage)
          expect(state.sort).toBe(second)
          expect(state.pagination.cursor).toBe(sortedCursor)
          expect(state.loading).toBe(false)
        } finally {
          store.destroy()
        }
      }),
      { numRuns: 50 },
    )
  })
})
