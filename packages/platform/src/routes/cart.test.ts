import { describe, it, expect, vi } from 'vitest'
import { registerCartRoutes, type RegisterCartRoutesDeps } from './cart.js'
import type { HttpAdapter, RouteHandler, Cart, CartItem } from '@nymbal/types'

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
      body?: unknown
      params?: Record<string, string>
      cookies?: Record<string, string>
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
      body: options.body ?? null,
      rawBody: undefined,
      headers: {},
      cookies: options.cookies ?? {},
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

function makeCart(overrides?: Partial<Cart>): Cart {
  return {
    token: 'cart-token-1',
    customerId: null,
    items: [],
    subtotalMinor: 0,
    currency: 'GBP',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeCartItem(overrides?: Partial<CartItem>): CartItem {
  return {
    variantId: 'var-1',
    productId: 'prod-1',
    productName: 'Test Product',
    variantName: 'Default',
    priceMinor: 1000,
    qty: 1,
    imageUrl: '',
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<RegisterCartRoutesDeps>): RegisterCartRoutesDeps {
  return {
    cart: {
      getOrCreate: vi.fn().mockResolvedValue(makeCart()),
      get: vi.fn().mockResolvedValue(null),
      addItem: vi.fn().mockResolvedValue(makeCart({ items: [makeCartItem()], subtotalMinor: 1000 })),
      updateItemQuantity: vi.fn().mockResolvedValue(makeCart()),
      removeItem: vi.fn().mockResolvedValue(makeCart()),
      clear: vi.fn().mockResolvedValue(makeCart()),
      merge: vi.fn().mockResolvedValue(makeCart()),
      attachCustomer: vi.fn().mockResolvedValue(makeCart()),
    },
    productRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 'prod-1',
        name: 'Test Product',
        media: [],
      }),
    } as unknown as RegisterCartRoutesDeps['productRepo'],
    variantRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 'var-1',
        productId: 'prod-1',
        name: 'Default',
        priceMinor: 1000,
        stock: 10,
      }),
    } as unknown as RegisterCartRoutesDeps['variantRepo'],
    ...overrides,
  }
}

describe('GET /api/cart', () => {
  it('returns a new cart when no cart cookie is present', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('GET', '/api/cart')
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Cart }
    expect(body.data).toBeTruthy()
    expect(body.data.token).toBe('cart-token-1')
    expect(deps.cart.getOrCreate).toHaveBeenCalled()
  })

  it('returns the existing cart when cart cookie is present', async () => {
    const existingCart = makeCart({ token: 'existing-token', items: [makeCartItem()] })
    const deps = makeDeps({
      cart: {
        ...makeDeps().cart,
        get: vi.fn().mockResolvedValue(existingCart),
      },
    })
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('GET', '/api/cart', { cookies: { 'nymbal.cart': 'existing-token' } })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Cart }
    expect(body.data.token).toBe('existing-token')
    expect(body.data.items).toHaveLength(1)
    expect(deps.cart.get).toHaveBeenCalledWith('existing-token')
  })

  it('response is wrapped in { data } envelope', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('GET', '/api/cart')
    const body = resp.body as Record<string, unknown>
    expect('data' in body).toBe(true)
    expect('error' in body).toBe(false)
  })

  it('sets cart cookie when creating new cart', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('GET', '/api/cart')
    expect(resp.cookies).toBeTruthy()
    const cartCookie = (resp.cookies as Array<{ name: string; value: string }>)?.find(
      (c) => c.name === 'nymbal.cart',
    )
    expect(cartCookie).toBeTruthy()
    expect(cartCookie?.value).toBe('cart-token-1')
  })
})

describe('POST /api/cart/items', () => {
  it('returns 400 when variantId is missing', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('POST', '/api/cart/items', { body: { qty: 1 } })
    expect(resp.status).toBe(400)
    const body = resp.body as { error: { code: string } }
    expect(body.error.code).toBe('cart.invalid')
  })

  it('returns 404 when variant is not found', async () => {
    const deps = makeDeps({
      variantRepo: {
        findById: vi.fn().mockResolvedValue(null),
      } as unknown as RegisterCartRoutesDeps['variantRepo'],
    })
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('POST', '/api/cart/items', { body: { variantId: 'v-missing' } })
    expect(resp.status).toBe(404)
  })

  it('returns 409 when stock is insufficient', async () => {
    const deps = makeDeps({
      variantRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'var-1', productId: 'prod-1', name: 'Default', priceMinor: 1000, stock: 2,
        }),
      } as unknown as RegisterCartRoutesDeps['variantRepo'],
    })
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('POST', '/api/cart/items', { body: { variantId: 'var-1', qty: 5 } })
    expect(resp.status).toBe(409)
    const body = resp.body as { error: { code: string; context: { available: number } } }
    expect(body.error.code).toBe('cart.out_of_stock')
    expect(body.error.context.available).toBe(2)
  })

  it('adds item and returns updated cart', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('POST', '/api/cart/items', {
      body: { variantId: 'var-1', qty: 1 },
      cookies: { 'nymbal.cart': 'cart-token-1' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Cart }
    expect(body.data.items).toHaveLength(1)
    expect(deps.cart.addItem).toHaveBeenCalled()
  })

  it('returns 404 when product is not found', async () => {
    const deps = makeDeps({
      productRepo: {
        findById: vi.fn().mockResolvedValue(null),
      } as unknown as RegisterCartRoutesDeps['productRepo'],
    })
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('POST', '/api/cart/items', { body: { variantId: 'var-1', qty: 1 } })
    expect(resp.status).toBe(404)
  })
})

describe('PATCH /api/cart/items/:variantId', () => {
  it('returns 404 when no cart cookie', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('PATCH', '/api/cart/items/:variantId', {
      params: { variantId: 'var-1' },
      body: { qty: 2 },
    })
    expect(resp.status).toBe(404)
  })

  it('returns 400 when variantId param is missing', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('PATCH', '/api/cart/items/:variantId', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      params: { variantId: '' },
      body: { qty: 2 },
    })
    expect(resp.status).toBe(400)
  })

  it('updates item quantity and returns cart', async () => {
    const updatedCart = makeCart({ items: [makeCartItem({ qty: 3 })], subtotalMinor: 3000 })
    const deps = makeDeps({
      cart: {
        ...makeDeps().cart,
        updateItemQuantity: vi.fn().mockResolvedValue(updatedCart),
      },
    })
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('PATCH', '/api/cart/items/:variantId', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      params: { variantId: 'var-1' },
      body: { qty: 3 },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Cart }
    expect(body.data.items[0]?.qty).toBe(3)
  })
})

describe('DELETE /api/cart/items/:variantId', () => {
  it('returns 404 when no cart cookie', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('DELETE', '/api/cart/items/:variantId', {
      params: { variantId: 'var-1' },
    })
    expect(resp.status).toBe(404)
  })

  it('removes item and returns updated cart', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('DELETE', '/api/cart/items/:variantId', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      params: { variantId: 'var-1' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Cart }
    expect(body.data.items).toHaveLength(0)
    expect(deps.cart.removeItem).toHaveBeenCalledWith('cart-token-1', 'var-1')
  })
})

describe('DELETE /api/cart', () => {
  it('returns 404 when no cart cookie', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('DELETE', '/api/cart')
    expect(resp.status).toBe(404)
  })

  it('clears cart and returns empty cart', async () => {
    const deps = makeDeps()
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('DELETE', '/api/cart', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Cart }
    expect(body.data.items).toHaveLength(0)
    expect(deps.cart.clear).toHaveBeenCalledWith('cart-token-1')
  })
})
