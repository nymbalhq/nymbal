import { describe, it, expect, vi } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { registerProductRoutes } from './products.js'
import type { HttpAdapter, RouteHandler, ReviewsAdapter } from '@nymbalhq/types'

function makeAdapter() {
  const routes = new Map<string, RouteHandler>()
  const adapter: HttpAdapter = {
    registerRoute(method, path, handler) {
      routes.set(`${method}:${path}`, handler)
    },
    registerStreamRoute() {},
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  async function invoke(
    method: string,
    path: string,
    query: Record<string, string> = {},
    params: Record<string, string> = {},
  ) {
    const handler = routes.get(`${method}:${path}`)
    if (!handler) throw new Error(`No route registered for ${method} ${path}`)
    return handler({
      method: method as 'GET',
      path,
      url: `http://localhost${path}`,
      params,
      query,
      body: null,
      headers: {},
      cookies: {},
      requestId: 'test-req',
      correlationId: 'test-corr',
      logger: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this
        },
      },
      ip: '127.0.0.1',
    })
  }
  return { adapter, invoke }
}

function makeReviewsAdapter(items: unknown[] = []): ReviewsAdapter {
  return {
    kind: 'reviews',
    providerName: 'mock',
    capabilities: () => [],
    producesEvents: [],
    consumesEvents: [],
    initialize: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ ok: true }),
    getProductReviews: vi.fn().mockResolvedValue({ items, nextCursor: null }),
    getAggregateRating: vi.fn(),
    submitReview: vi.fn(),
    requestReview: vi.fn(),
  } as unknown as ReviewsAdapter
}

describe('GET /api/products/:id/reviews', () => {
  it('answers the asked product’s reviews from the adapter, at most ?limit of them (capped at 100)', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const all = [
      ...['a', 'b', 'c'].map((n) => ({ id: `p1-${n}`, productId: 'p1', rating: 5 })),
      ...['a', 'b'].map((n) => ({ id: `p2-${n}`, productId: 'p2', rating: 4 })),
    ]
    const reviewsAdapter = makeReviewsAdapter()
    reviewsAdapter.getProductReviews = (async (productId: string, opts: { limit: number }) => {
      const mine = all.filter((r) => r.productId === productId)
      return {
        items: mine.slice(0, opts.limit),
        nextCursor: mine.length > opts.limit ? 'next' : null,
      }
    }) as unknown as ReviewsAdapter['getProductReviews']

    const { adapter, invoke } = makeAdapter()
    registerProductRoutes(adapter, documentStore, 'test', reviewsAdapter)

    for (const limit of ['1', '2', '500']) {
      const resp = await invoke('GET', '/api/products/:id/reviews', { limit }, { id: 'p1' })
      expect(resp.status).toBe(200)
      const ids = (resp.body as { data: { items: Array<{ id: string }> } }).data.items.map(
        (r) => r.id,
      )
      const expected = all
        .filter((r) => r.productId === 'p1')
        .slice(0, Math.min(100, Number(limit)))
      expect(ids, `?limit=${limit}`).toEqual(expected.map((r) => r.id))
    }
  })

  it('returns empty items when no reviews adapter is provided', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerProductRoutes(adapter, documentStore, 'test')

    const resp = await invoke('GET', '/api/products/:id/reviews', {}, { id: 'p1' })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { items: unknown[] } }
    expect(body.data.items).toHaveLength(0)
  })
})

describe('GET /api/products/search: the category facet', () => {
  it('AC-10: resolves the facet’s category ids with one categoriesById call and never pages categories: with 1, 3 and 10 pages of categories and an id with no category, the facet is the known ones in the adapter’s order with its counts, and categories is queried 0 times', async () => {
    const PAGE = 500
    for (const pages of [1, 3, 10]) {
      const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
      const count = PAGE * (pages - 1) + 1 + Math.floor(PAGE / 2)
      const categories = Array.from({ length: count }, (_, i) => ({
        id: `cat-id-${i}`,
        slug: `cat-${i}`,
        name: `Category ${i}`,
        storeId: 'test',
        position: i,
      }))
      for (const c of categories) await documentStore.put('categories', c.slug, c)
      await documentStore.put('products', 'lamp', { id: 'p-lamp', slug: 'lamp', name: 'Lamp' })

      let categoryQueries = 0
      const query = documentStore.query.bind(documentStore)
      documentStore.query = (async (collection: string, params: Parameters<typeof query>[1]) => {
        if (collection === 'categories') categoryQueries += 1
        return query(collection, params)
      }) as typeof documentStore.query

      const last = categories[categories.length - 1]!
      const first = categories[0]!
      const middle = categories[Math.floor(categories.length / 2)]!
      const counts = [
        { value: last.id, count: 5 },
        { value: 'deleted-category', count: 4 },
        { value: first.id, count: 3 },
        { value: middle.id, count: 1 },
      ]
      const byId = new Map(categories.map((c) => [c.id, { id: c.id, slug: c.slug, name: c.name }]))
      const lookups: string[][] = []
      const categoriesById = async (ids: readonly string[]) => {
        lookups.push([...ids])
        return new Map(ids.flatMap((id) => (byId.has(id) ? [[id, byId.get(id)!] as const] : [])))
      }

      const { adapter, invoke } = makeAdapter()
      registerProductRoutes(
        adapter,
        documentStore,
        'test',
        undefined,
        {
          products: async () => ({
            items: [{ id: 'p-lamp', type: 'product', fields: { slug: 'lamp' } }],
            total: 13,
            nextCursor: null,
          }),
        },
        () => true,
        async (field) => ({ field, label: field, values: counts }),
        categoriesById,
      )

      const resp = await invoke('GET', '/api/products/search', { q: 'lamp' })
      expect(resp.status, `${pages} pages`).toBe(200)
      const facets = (resp.body as { data: { facets: unknown[] } }).data.facets
      expect(facets, `${pages} pages: the facet`).toEqual([
        {
          field: 'category',
          label: 'Category',
          values: [last, first, middle].map((c) => ({
            value: c.slug,
            label: c.name,
            count: counts.find((v) => v.value === c.id)!.count,
          })),
        },
      ])
      expect(categoryQueries, `${pages} pages: queries of categories`).toBe(0)
      expect(lookups.length, `${pages} pages: categoriesById calls`).toBe(1)
      expect([...lookups[0]!].sort(), `${pages} pages: the ids looked up`).toEqual(
        counts.map((v) => v.value).sort(),
      )
    }
  })
})
