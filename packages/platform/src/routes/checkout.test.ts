import { describe, it, expect, vi } from 'vitest'
import { registerCheckoutRoutes } from './checkout.js'
import type { HttpAdapter, RouteHandler, Address } from '@nymbal/types'
import type { CheckoutService } from '../services/checkout-service.js'

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
      cookies?: Record<string, string>
    } = {},
  ) {
    const handler = routes.get(`${method}:${path}`)
    if (!handler) throw new Error(`No route registered for ${method} ${path}`)
    return handler({
      method: method as 'POST',
      path,
      url: `http://localhost${path}`,
      params: {},
      query: {},
      body: options.body ?? null,
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

const testAddress: Address = {
  firstName: 'Jane',
  lastName: 'Doe',
  addressLine1: '1 Test Street',
  city: 'London',
  region: 'England',
  postalCode: 'SW1A 1AA',
  country: 'GB',
}

const checkoutResult = {
  orderId: 'ord-123',
  orderNumber: 'NYM-001',
  paymentIntent: {
    id: 'pi_test',
    clientSecret: 'pi_test_secret',
    amountMinor: 2000,
    currency: 'GBP',
    status: 'requires_payment_method' as const,
  },
  currency: 'GBP',
  totalMinor: 2000,
}

function makeCheckoutService(overrides?: Partial<CheckoutService>): CheckoutService {
  return {
    beginCheckout: vi.fn().mockResolvedValue(checkoutResult),
    finalize: vi.fn().mockResolvedValue({ orderNumber: 'NYM-001' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('POST /api/checkout', () => {
  it('returns 400 when no cart cookie is present', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCheckoutRoutes(adapter, makeCheckoutService())

    const resp = await invoke('POST', '/api/checkout', {
      body: { email: 'test@example.com', billingAddress: testAddress, shippingAddress: testAddress },
    })
    expect(resp.status).toBe(400)
    const body = resp.body as { error: { code: string } }
    expect(body.error.code).toBe('checkout.no_cart')
  })

  it('returns 400 when email is missing', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCheckoutRoutes(adapter, makeCheckoutService())

    const resp = await invoke('POST', '/api/checkout', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      body: { billingAddress: testAddress, shippingAddress: testAddress },
    })
    expect(resp.status).toBe(400)
    const body = resp.body as { error: { code: string } }
    expect(body.error.code).toBe('checkout.invalid')
  })

  it('returns 400 when billingAddress is missing', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCheckoutRoutes(adapter, makeCheckoutService())

    const resp = await invoke('POST', '/api/checkout', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      body: { email: 'test@example.com', shippingAddress: testAddress },
    })
    expect(resp.status).toBe(400)
  })

  it('returns 400 when shippingAddress is missing', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCheckoutRoutes(adapter, makeCheckoutService())

    const resp = await invoke('POST', '/api/checkout', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      body: { email: 'test@example.com', billingAddress: testAddress },
    })
    expect(resp.status).toBe(400)
  })

  it('begins checkout and returns orderId, orderNumber, paymentIntent, currency, totalMinor', async () => {
    const service = makeCheckoutService()
    const { adapter, invoke } = makeAdapter()
    registerCheckoutRoutes(adapter, service)

    const resp = await invoke('POST', '/api/checkout', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      body: {
        email: 'buyer@example.com',
        billingAddress: testAddress,
        shippingAddress: testAddress,
      },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as {
      data: {
        orderId: string
        orderNumber: string
        paymentIntent: { id: string; clientSecret: string }
        currency: string
        totalMinor: number
      }
    }
    expect(body.data.orderId).toBe('ord-123')
    expect(body.data.orderNumber).toBe('NYM-001')
    expect(body.data.paymentIntent.id).toBe('pi_test')
    expect(body.data.currency).toBe('GBP')
    expect(body.data.totalMinor).toBe(2000)
  })

  it('passes cartToken and email to checkout.beginCheckout', async () => {
    const service = makeCheckoutService()
    const { adapter, invoke } = makeAdapter()
    registerCheckoutRoutes(adapter, service)

    await invoke('POST', '/api/checkout', {
      cookies: { 'nymbal.cart': 'cart-token-42' },
      body: {
        email: 'buyer@example.com',
        billingAddress: testAddress,
        shippingAddress: testAddress,
      },
    })
    expect(service.beginCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ cartToken: 'cart-token-42', email: 'buyer@example.com' }),
    )
  })

  it('passes notes to checkout.beginCheckout when provided', async () => {
    const service = makeCheckoutService()
    const { adapter, invoke } = makeAdapter()
    registerCheckoutRoutes(adapter, service)

    await invoke('POST', '/api/checkout', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      body: {
        email: 'buyer@example.com',
        billingAddress: testAddress,
        shippingAddress: testAddress,
        notes: 'Leave at door',
      },
    })
    expect(service.beginCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'Leave at door' }),
    )
  })

  it('response is wrapped in { data } envelope', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCheckoutRoutes(adapter, makeCheckoutService())

    const resp = await invoke('POST', '/api/checkout', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      body: {
        email: 'buyer@example.com',
        billingAddress: testAddress,
        shippingAddress: testAddress,
      },
    })
    const body = resp.body as Record<string, unknown>
    expect('data' in body).toBe(true)
    expect('error' in body).toBe(false)
  })

  it('returns 500 when checkout service throws', async () => {
    const service = makeCheckoutService({
      beginCheckout: vi.fn().mockRejectedValue(new Error('cart is empty')),
    })
    const { adapter, invoke } = makeAdapter()
    registerCheckoutRoutes(adapter, service)

    const resp = await invoke('POST', '/api/checkout', {
      cookies: { 'nymbal.cart': 'cart-token-1' },
      body: {
        email: 'buyer@example.com',
        billingAddress: testAddress,
        shippingAddress: testAddress,
      },
    })
    expect(resp.status).toBe(500)
  })
})
