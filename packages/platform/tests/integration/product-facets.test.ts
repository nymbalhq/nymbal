import { describe, it, expect } from 'vitest'
import { createTestEnv } from './setup.js'
import { registerCategoryProjection } from '../../src/handlers/projections/category-projection.js'
import { registerProductProjection, type DenormalisedProduct } from '../../src/handlers/projections/product-projection.js'
import { createLogger } from '../../src/logger.js'
import { registerProductRoutes } from '../../src/routes/products.js'
import type { HttpAdapter, RouteHandler } from '@nymbal/types'

const logger = createLogger({ pretty: false, level: 'error' })

function makeAdapter() {
  const routes = new Map<string, RouteHandler>()
  const adapter: HttpAdapter = {
    registerRoute(method, path, handler) { routes.set(`${method}:${path}`, handler) },
    registerStreamRoute() {},
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  async function invoke(method: string, path: string, query: Record<string, string> = {}) {
    const handler = routes.get(`${method}:${path}`)
    if (!handler) throw new Error(`No handler for ${method} ${path}`)
    return handler({
      method: method as 'GET',
      path,
      url: `http://localhost${path}`,
      params: {},
      query,
      body: null,
      rawBody: undefined,
      headers: {},
      cookies: {},
      requestId: 'int-req',
      correlationId: 'int-corr',
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
      ip: '127.0.0.1',
    })
  }
  return { adapter, invoke }
}

describe('product facets integration: category → product → GET /api/products', () => {
  it('returns non-empty facet values after category and product are created', async () => {
    const env = await createTestEnv()

    // Register projections (category before product so category doc exists when product event fires)
    await registerCategoryProjection({
      eventBus: env.eventBus,
      documentStore: env.documentStore,
      logger,
      storeId: 'test',
    })
    await registerProductProjection({
      eventBus: env.eventBus,
      documentStore: env.documentStore,
      logger,
      storeId: 'test',
      currency: 'GBP',
    })

    // Create a category — EVT_CATEGORY_CREATED handled by category projection
    const cat = await env.category.create({
      slug: 'fiction',
      name: 'Fiction',
      description: 'Fiction books',
    })

    // Create a product in that category — EVT_PRODUCT_CREATED handled by product projection
    await env.product.create({
      slug: 'great-gatsby',
      name: 'The Great Gatsby',
      description: 'Classic novel',
      status: 'active',
      categoryIds: [cat.id],
      variants: [{ sku: 'GG-1', name: 'Default', priceMinor: 1299, stock: 10, options: [] }],
    })

    // The in-process event bus dispatches synchronously so no extra await needed,
    // but a tick lets any microtask-chained writes settle.
    await new Promise((r) => setImmediate(r))

    // Verify product doc has the categories field populated
    const doc = await env.documentStore.get<DenormalisedProduct>('products', 'great-gatsby')
    expect(doc).not.toBeNull()
    expect(doc!.categories).toHaveLength(1)
    expect(doc!.categories[0]).toMatchObject({ slug: 'fiction', name: 'Fiction' })

    // Verify GET /api/products returns facets with a non-empty values array
    const { adapter, invoke } = makeAdapter()
    registerProductRoutes(adapter, env.documentStore, 'test')

    const resp = await invoke('GET', '/api/products')
    expect(resp.status).toBe(200)
    const body = resp.body as {
      data: {
        items: unknown[]
        facets: Array<{ field: string; values: Array<{ value: string; label: string; count: number }> }>
      }
    }
    expect(body.data.items).toHaveLength(1)
    const facet = body.data.facets.find((f) => f.field === 'category')!
    expect(facet.values.length).toBeGreaterThan(0)
    expect(facet.values[0]).toMatchObject({ value: 'fiction', label: 'Fiction', count: 1 })

    await env.commandStore.close()
  })

  it('category filter returns only matching products with correct facets', async () => {
    const env = await createTestEnv()

    await registerCategoryProjection({ eventBus: env.eventBus, documentStore: env.documentStore, logger, storeId: 'test' })
    await registerProductProjection({ eventBus: env.eventBus, documentStore: env.documentStore, logger, storeId: 'test', currency: 'GBP' })

    const fiction = await env.category.create({ slug: 'fiction', name: 'Fiction', description: '' })
    const science = await env.category.create({ slug: 'science', name: 'Science', description: '' })

    await env.product.create({
      slug: 'gatsby', name: 'Gatsby', status: 'active', categoryIds: [fiction.id],
      variants: [{ sku: 'G1', name: 'Default', priceMinor: 999, stock: 5, options: [] }],
    })
    await env.product.create({
      slug: 'cosmos', name: 'Cosmos', status: 'active', categoryIds: [science.id],
      variants: [{ sku: 'C1', name: 'Default', priceMinor: 1499, stock: 3, options: [] }],
    })

    await new Promise((r) => setImmediate(r))

    const { adapter, invoke } = makeAdapter()
    registerProductRoutes(adapter, env.documentStore, 'test')

    // Filter by fiction slug — projection now keys products-by-category by slug
    const resp = await invoke('GET', '/api/products', { category: fiction.slug })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { items: Array<{ slug: string }>; facets: Array<{ field: string; values: unknown[] }> } }
    expect(body.data.items).toHaveLength(1)
    expect((body.data.items[0] as { slug: string }).slug).toBe('gatsby')

    await env.commandStore.close()
  })
})
