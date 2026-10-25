import fc from 'fast-check'
import { describe, it, expect } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { registerCategoryRoutes } from './categories.js'
import type { HttpAdapter, RouteHandler, Category } from '@nymbalhq/types'

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
  async function invoke(method: string, path: string) {
    const handler = routes.get(`${method}:${path}`)
    if (!handler) throw new Error(`No route registered for ${method} ${path}`)
    return handler({
      method: method as 'GET',
      path,
      url: `http://localhost${path}`,
      params: {},
      query: {},
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

describe('GET /api/categories', () => {
  it('returns exactly the store’s categories, positions non-decreasing, over generated positions and a second store', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ position: fc.integer({ min: -5, max: 50 }), mine: fc.boolean() }), {
          maxLength: 12,
        }),
        async (seeds) => {
          const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
          for (const [i, seed] of seeds.entries()) {
            await documentStore.put('categories', `cat-${i}`, {
              id: `cat-${i}`,
              storeId: seed.mine ? 'test-store' : 'other-store',
              parentId: null,
              slug: `cat-${i}`,
              name: `Category ${i}`,
              description: '',
              position: seed.position,
              createdAt: '2024-01-01T00:00:00Z',
            })
          }
          const { adapter, invoke } = makeAdapter()
          registerCategoryRoutes(adapter, documentStore, 'test-store')

          const resp = await invoke('GET', '/api/categories')
          expect(resp.status).toBe(200)
          const listed = (resp.body as { data: Category[] }).data
          const positions = listed.map((c) => c.position)
          expect(positions.every((p, i) => i === 0 || positions[i - 1]! <= p)).toBe(true)
          expect(listed.map((c) => c.id).sort()).toEqual(
            seeds.flatMap((seed, i) => (seed.mine ? [`cat-${i}`] : [])).sort(),
          )
        },
      ),
      { numRuns: 30 },
    )
  })
})
