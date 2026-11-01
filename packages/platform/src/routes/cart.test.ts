import fc from 'fast-check'
import { describe, it, expect, vi } from 'vitest'
import { mergeCartOnSignIn, registerCartRoutes, type RegisterCartRoutesDeps } from './cart.js'
import type {
  HttpAdapter,
  RequestContext,
  ResponseCookie,
  RouteHandler,
  Cart,
  CartItem,
} from '@nymbalhq/types'

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
      headers: {},
      cookies: options.cookies ?? {},
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

/** The repositories' store: `read` runs its callback at once with a handle the stubbed `findById` ignores. */
const stubStore = {
  kind: 'sqlite',
  read: (fn: (tx: unknown) => Promise<unknown>) => fn({ kind: 'sqlite' }),
  transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ kind: 'sqlite' }),
  close: async () => {},
}

function makeDeps(overrides?: Partial<RegisterCartRoutesDeps>): RegisterCartRoutesDeps {
  return {
    cart: {
      getOrCreate: vi.fn().mockResolvedValue(makeCart()),
      get: vi.fn().mockResolvedValue(null),
      addItem: vi
        .fn()
        .mockResolvedValue(makeCart({ items: [makeCartItem()], subtotalMinor: 1000 })),
      updateItemQuantity: vi.fn().mockResolvedValue(makeCart()),
      removeItem: vi.fn().mockResolvedValue(makeCart()),
      clear: vi.fn().mockResolvedValue(makeCart()),
      merge: vi.fn().mockResolvedValue(makeCart()),
      attachCustomer: vi.fn().mockResolvedValue(makeCart()),
      signIn: vi.fn().mockResolvedValue(null),
    },
    productRepo: {
      store: stubStore,
      findById: vi.fn().mockResolvedValue({
        id: 'prod-1',
        slug: 'test-product',
        name: 'Test Product',
        status: 'active',
        media: [],
      }),
    } as unknown as RegisterCartRoutesDeps['productRepo'],
    variantRepo: {
      store: stubStore,
      findById: vi.fn().mockResolvedValue({
        id: 'var-1',
        productId: 'prod-1',
        name: 'Default',
        priceMinor: 1000,
        stock: 10,
        status: 'active',
      }),
    } as unknown as RegisterCartRoutesDeps['variantRepo'],
    ...overrides,
  }
}

describe('GET /api/cart', () => {
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
  it('returns 404 when variant is not found', async () => {
    const deps = makeDeps({
      variantRepo: {
        store: stubStore,
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
        store: stubStore,
        findById: vi.fn().mockResolvedValue({
          id: 'var-1',
          productId: 'prod-1',
          name: 'Default',
          priceMinor: 1000,
          stock: 2,
          status: 'active',
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

  it('adds the variant as one more line, at the variant’s price and the product’s name, and returns that cart', async () => {
    const held = makeCart({ items: [makeCartItem({ variantId: 'var-0' })] })
    const deps = makeDeps()
    deps.cart.addItem = vi.fn(async (_token: string, item: CartItem) => {
      held.items = [...held.items, item]
      return held
    }) as unknown as RegisterCartRoutesDeps['cart']['addItem']
    const before = held.items.length
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)

    const resp = await invoke('POST', '/api/cart/items', {
      body: { variantId: 'var-1', qty: 2 },
      cookies: { 'nymbal.cart': 'cart-token-1' },
    })
    expect(resp.status).toBe(200)
    const items = (resp.body as { data: Cart }).data.items
    expect(items.length).toBe(before + 1)
    const line = items[items.length - 1]!
    expect([line.variantId, line.productName, line.priceMinor, line.qty]).toEqual([
      'var-1',
      'Test Product',
      1000,
      2,
    ])
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
})

describe('DELETE /api/cart', () => {
  it('empties the cart the cookie names and leaves another cart as it was', async () => {
    const carts = new Map<string, Cart>([
      ['cart-a', makeCart({ token: 'cart-a', items: [makeCartItem()], subtotalMinor: 1000 })],
      [
        'cart-b',
        makeCart({
          token: 'cart-b',
          items: [makeCartItem({ variantId: 'var-2', qty: 3 })],
          subtotalMinor: 3000,
        }),
      ],
    ])
    const otherBefore = structuredClone(carts.get('cart-b'))
    const deps = makeDeps()
    deps.cart.get = vi.fn(async (token: string) => carts.get(token) ?? null)
    deps.cart.clear = vi.fn(async (token: string) => {
      const held = carts.get(token)
      if (held === undefined) throw new Error(`no cart ${token}`)
      const cleared = { ...held, items: [], subtotalMinor: 0 }
      carts.set(token, cleared)
      return cleared
    })
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)
    const cartOf = async (token: string) =>
      (
        (await invoke('GET', '/api/cart', { cookies: { 'nymbal.cart': token } })).body as {
          data: Cart
        }
      ).data

    const resp = await invoke('DELETE', '/api/cart', { cookies: { 'nymbal.cart': 'cart-a' } })

    expect(resp.status).toBe(200)
    expect((resp.body as { data: Cart }).data.items).toEqual([])
    expect((await cartOf('cart-a')).items).toEqual([])
    expect(await cartOf('cart-b')).toEqual(otherBefore)
  })
})

/** A request as the auth routes hand it to an after-sign-in hook: only its cookies matter here. */
function signInRequest(cookies: Record<string, string>): RequestContext {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger
    },
  }
  return {
    method: 'POST',
    path: '/api/auth/login',
    url: 'http://localhost/api/auth/login',
    params: {},
    query: {},
    body: null,
    headers: {},
    cookies,
    requestId: 'test-req',
    correlationId: 'test-corr',
    logger,
    ip: '127.0.0.1',
  } as unknown as RequestContext
}

describe('the cart’s after-sign-in hook', () => {
  /** The cart cookie GET /api/cart sets for a new cart with this token: the shape a cart cookie has. */
  async function routeCookieFor(token: string): Promise<ResponseCookie | undefined> {
    const deps = makeDeps()
    deps.cart.getOrCreate = vi.fn().mockResolvedValue(makeCart({ token }))
    const { adapter, invoke } = makeAdapter()
    registerCartRoutes(adapter, deps)
    const resp = await invoke('GET', '/api/cart')
    return (resp.cookies as ResponseCookie[] | undefined)?.find((c) => c.name === 'nymbal.cart')
  }

  // Kills: the hook reading another cookie or dropping the customer, a result's token not sent, and a cookie for a
  // cart the customer cannot have (another customer's) left in the browser after a null result.
  it('AC-8: property: the hook answers the cart cookie naming the cart signIn returns for the request’s nymbal.cart and the customer, shaped as the cart route sets it; on a null result it expires the cookie the request carried (path /, Max-Age 0), and answers none when it carried none', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.uuid(), { nil: undefined }),
        fc.uuid(),
        fc.boolean(),
        async (guestToken, customerId, found) => {
          // signIn as a function of what it is given, so the token sent back proves both arguments reached it.
          const resultOf = (guest: string | undefined, customer: string): Cart | null =>
            found
              ? makeCart({ token: `${guest ?? 'none'}:${customer}`, customerId: customer })
              : null
          const cart = {
            ...makeDeps().cart,
            signIn: async (guest: string | undefined, customer: string) =>
              resultOf(guest, customer),
          }
          const request = signInRequest(
            guestToken === undefined ? {} : { 'nymbal.cart': guestToken },
          )

          const answered = await mergeCartOnSignIn(cart)(request, customerId)

          const cartCookies = answered.filter((c: ResponseCookie) => c.name === 'nymbal.cart')
          const result = resultOf(guestToken, customerId)
          // A result's cookie is compared whole; an expiry by its path and Max-Age alone (its value is not the point).
          const shape = (c: ResponseCookie | undefined) =>
            result === null ? { path: c?.path, maxAge: c?.maxAge } : c
          const expected =
            result !== null
              ? [await routeCookieFor(result.token)]
              : guestToken === undefined
                ? []
                : [{ path: '/', maxAge: 0 }]
          expect(cartCookies.map(shape)).toEqual(expected)
        },
      ),
      { numRuns: 60 },
    )
  })
})
