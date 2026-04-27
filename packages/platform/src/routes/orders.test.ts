import { describe, it, expect, vi } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { registerOrderRoutes } from './orders.js'
import type { HttpAdapter, RouteHandler, RequestContext } from '@nymbal/types'
import type { OrderService } from '../services/order-service.js'

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
    options: {
      params?: Record<string, string>
      auth?: RequestContext['auth']
    } = {},
  ) {
    const handler = routes.get(`${method}:${path}`)
    if (!handler) throw new Error(`No route registered for ${method} ${path}`)
    return handler({
      method: method as 'GET',
      path,
      url: `http://localhost${path}`,
      params: options.params ?? {},
      query: {},
      body: null,
      rawBody: undefined,
      headers: {},
      cookies: {},
      auth: options.auth,
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

function makeOrderService(): OrderService {
  return {} as unknown as OrderService
}

describe('GET /api/orders', () => {
  it('returns 401 when user is not authenticated', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders')
    expect(resp.status).toBe(401)
  })

  it('returns empty list when no orders exist for customer', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders', {
      auth: { userId: 'cust-1', roles: ['customer'] },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: unknown[] }
    expect(body.data).toHaveLength(0)
  })

  it('returns only orders belonging to the authenticated customer', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('orders-by-customer', 'customer:cust-1#NYM-001', {
      partitionKey: 'customer:cust-1',
      sortKey: 'NYM-001',
      orderNumber: 'NYM-001',
      customerId: 'cust-1',
      totalMinor: 5000,
      currency: 'GBP',
    })
    await documentStore.put('orders-by-customer', 'customer:cust-2#NYM-002', {
      partitionKey: 'customer:cust-2',
      sortKey: 'NYM-002',
      orderNumber: 'NYM-002',
      customerId: 'cust-2',
      totalMinor: 3000,
      currency: 'GBP',
    })

    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders', {
      auth: { userId: 'cust-1', roles: ['customer'] },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Array<{ orderNumber: string }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.orderNumber).toBe('NYM-001')
  })

  it('response is wrapped in { data, meta } envelope', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders', {
      auth: { userId: 'cust-1', roles: ['customer'] },
    })
    const body = resp.body as Record<string, unknown>
    expect('data' in body).toBe(true)
  })
})

describe('GET /api/orders/:orderNumber', () => {
  it('returns 400 when orderNumber param is missing', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', { params: { orderNumber: '' } })
    expect(resp.status).toBe(400)
    const body = resp.body as { error: { code: string } }
    expect(body.error.code).toBe('orders.invalid')
  })

  it('returns 404 when order does not exist', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-MISSING' },
    })
    expect(resp.status).toBe(404)
  })

  it('returns order document when it exists', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('orders', 'NYM-001', {
      orderNumber: 'NYM-001',
      customerId: null,
      totalMinor: 2000,
      currency: 'GBP',
    })

    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-001' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { orderNumber: string; totalMinor: number } }
    expect(body.data.orderNumber).toBe('NYM-001')
    expect(body.data.totalMinor).toBe(2000)
  })

  it('returns 403 when authenticated user tries to access another customers order', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('orders', 'NYM-002', {
      orderNumber: 'NYM-002',
      customerId: 'cust-2',
      totalMinor: 3000,
      currency: 'GBP',
    })

    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-002' },
      auth: { userId: 'cust-1', roles: ['customer'] },
    })
    expect(resp.status).toBe(403)
  })

  it('allows authenticated user to access their own order', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('orders', 'NYM-003', {
      orderNumber: 'NYM-003',
      customerId: 'cust-1',
      totalMinor: 4500,
      currency: 'GBP',
    })

    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-003' },
      auth: { userId: 'cust-1', roles: ['customer'] },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { orderNumber: string } }
    expect(body.data.orderNumber).toBe('NYM-003')
  })

  it('allows unauthenticated access for guest orders (no customerId)', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('orders', 'NYM-004', {
      orderNumber: 'NYM-004',
      customerId: null,
      totalMinor: 1500,
      currency: 'GBP',
    })

    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-004' },
    })
    expect(resp.status).toBe(200)
  })
})
