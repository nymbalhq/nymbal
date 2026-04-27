import { describe, it, expect, vi } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { registerProductRoutes } from './products.js'
import type { HttpAdapter, RouteHandler, ReviewsAdapter } from '@nymbal/types'

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
      rawBody: undefined,
      headers: {},
      cookies: {},
      requestId: 'test-req',
      correlationId: 'test-corr',
      logger: {
        trace() {}, debug() {}, info() {}, warn() {}, error() {},
        child() { return this },
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
    capabilities: [],
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

describe('GET /api/products facet computation', () => {
  it('returns empty facet values when no products have categories', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('products', 'p1', {
      id: 'p1', slug: 'p1', name: 'P1', storeId: 'test',
      status: 'active', categories: [],
    })
    const { adapter, invoke } = makeAdapter()
    registerProductRoutes(adapter, documentStore, 'test')

    const resp = await invoke('GET', '/api/products')
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { facets: Array<{ field: string; values: unknown[] }> } }
    const facet = body.data.facets.find((f) => f.field === 'category')
    expect(facet?.values).toHaveLength(0)
  })

  it('counts category occurrences across returned products', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const cats = [
      { id: 'c1', name: 'Books', slug: 'books' },
      { id: 'c2', name: 'Electronics', slug: 'electronics' },
    ]
    for (let i = 1; i <= 3; i++) {
      await documentStore.put('products', `book-${i}`, {
        id: `book-${i}`, slug: `book-${i}`, name: `Book ${i}`, storeId: 'test',
        status: 'active', categories: [cats[0]],
      })
    }
    for (let i = 1; i <= 2; i++) {
      await documentStore.put('products', `elec-${i}`, {
        id: `elec-${i}`, slug: `elec-${i}`, name: `Elec ${i}`, storeId: 'test',
        status: 'active', categories: [cats[1]],
      })
    }

    const { adapter, invoke } = makeAdapter()
    registerProductRoutes(adapter, documentStore, 'test')

    const resp = await invoke('GET', '/api/products')
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { facets: Array<{ field: string; values: Array<{ value: string; label: string; count: number }> }> } }
    const facet = body.data.facets.find((f) => f.field === 'category')!
    expect(facet.values).toHaveLength(2)

    const books = facet.values.find((v) => v.value === 'books')!
    expect(books).toMatchObject({ value: 'books', label: 'Books', count: 3 })

    const elec = facet.values.find((v) => v.value === 'electronics')!
    expect(elec).toMatchObject({ value: 'electronics', label: 'Electronics', count: 2 })
  })

  it('filters products by category slug via ?category= param, facets always show all categories', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    // Filtered result: only the book
    await documentStore.put('products-by-category', 'category:books#product:moby-dick', {
      id: 'p1', slug: 'moby-dick', name: 'Moby Dick', storeId: 'test',
      partitionKey: 'category:books', sortKey: 'product:moby-dick',
      categories: [{ id: 'c1', name: 'Books', slug: 'books' }],
    })
    // Full catalog (used for facet computation): book + electronics item
    await documentStore.put('products', 'moby-dick', {
      id: 'p1', slug: 'moby-dick', name: 'Moby Dick', storeId: 'test',
      categories: [{ id: 'c1', name: 'Books', slug: 'books' }],
    })
    await documentStore.put('products', 'laptop', {
      id: 'p2', slug: 'laptop', name: 'Laptop', storeId: 'test',
      categories: [{ id: 'c2', name: 'Electronics', slug: 'electronics' }],
    })

    const { adapter, invoke } = makeAdapter()
    registerProductRoutes(adapter, documentStore, 'test')

    const resp = await invoke('GET', '/api/products', { category: 'books' })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { items: unknown[]; facets: Array<{ field: string; values: Array<{ value: string }> }> } }
    // Items are filtered to the requested category
    expect(body.data.items).toHaveLength(1)
    // Facets always reflect the FULL catalog so all category options remain visible
    const facet = body.data.facets.find((f) => f.field === 'category')!
    expect(facet.values).toHaveLength(2)
    expect(facet.values.map((v) => v.value).sort()).toEqual(['books', 'electronics'])
  })
})

describe('GET /api/products/:id/reviews', () => {
  it('returns reviews from the reviews adapter', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const reviews = [
      { id: 'r1', productId: 'p1', customerId: null, rating: 5, title: 'Great', body: 'Loved it', submittedAt: '2024-01-01T00:00:00Z' },
    ]
    const reviewsAdapter = makeReviewsAdapter(reviews)

    const { adapter, invoke } = makeAdapter()
    registerProductRoutes(adapter, documentStore, 'test', reviewsAdapter)

    const resp = await invoke('GET', '/api/products/:id/reviews', {}, { id: 'p1' })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { items: unknown[]; nextCursor: string | null } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.nextCursor).toBeNull()
    expect(body.data.items[0]).toMatchObject({ id: 'r1', rating: 5, title: 'Great' })
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

  it('returns 400 when product id is missing', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerProductRoutes(adapter, documentStore, 'test')

    const resp = await invoke('GET', '/api/products/:id/reviews', {}, { id: '' })
    expect(resp.status).toBe(400)
  })
})
