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
