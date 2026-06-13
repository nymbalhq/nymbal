import { describe, it, expect } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { registerCategoryRoutes } from './categories.js'
import type { HttpAdapter, RouteHandler, Category } from '@nymbal/types'

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
        trace() {}, debug() {}, info() {}, warn() {}, error() {},
        child() { return this },
      },
      ip: '127.0.0.1',
    })
  }
  return { adapter, invoke }
}

describe('GET /api/categories', () => {
  it('returns an empty array when no categories exist', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerCategoryRoutes(adapter, documentStore, 'test-store')

    const resp = await invoke('GET', '/api/categories')
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Category[] }
    expect(body.data).toEqual([])
  })

  it('returns categories belonging to the store, sorted by position', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('categories', 'electronics', {
      id: 'c2', storeId: 'test-store', parentId: null,
      slug: 'electronics', name: 'Electronics', description: '', position: 1, createdAt: '2024-01-01T00:00:00Z',
    })
    await documentStore.put('categories', 'apparel', {
      id: 'c1', storeId: 'test-store', parentId: null,
      slug: 'apparel', name: 'Apparel', description: '', position: 0, createdAt: '2024-01-01T00:00:00Z',
    })

    const { adapter, invoke } = makeAdapter()
    registerCategoryRoutes(adapter, documentStore, 'test-store')

    const resp = await invoke('GET', '/api/categories')
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Category[] }
    expect(body.data).toHaveLength(2)
    expect(body.data[0]?.slug).toBe('apparel')
    expect(body.data[1]?.slug).toBe('electronics')
  })

  it('response includes all Category fields including parentId', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('categories', 'mens', {
      id: 'c3', storeId: 'test-store', parentId: 'c1',
      slug: 'mens', name: 'Mens', description: 'Mens clothing', position: 0, createdAt: '2024-01-01T00:00:00Z',
    })

    const { adapter, invoke } = makeAdapter()
    registerCategoryRoutes(adapter, documentStore, 'test-store')

    const resp = await invoke('GET', '/api/categories')
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Category[] }
    const cat = body.data[0]!
    expect(cat).toMatchObject({
      id: 'c3',
      parentId: 'c1',
      slug: 'mens',
      name: 'Mens',
      description: 'Mens clothing',
      position: 0,
    })
  })

  it('wraps response in the { data } envelope', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerCategoryRoutes(adapter, documentStore, 'test-store')

    const resp = await invoke('GET', '/api/categories')
    const body = resp.body as Record<string, unknown>
    expect('data' in body).toBe(true)
    expect('error' in body).toBe(false)
  })
})
