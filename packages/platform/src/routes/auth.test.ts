import { describe, it, expect, vi } from 'vitest'
import { registerAuthRoutes } from './auth.js'
import type { HttpAdapter, RouteHandler, Customer } from '@nymbal/types'
import type { AuthService, AuthTokens } from '../services/auth-service.js'

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

const testCustomer: Customer = {
  id: 'cust-1',
  email: 'test@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  phone: '',
  addresses: [],
  orderCount: 0,
  totalSpentMinor: 0,
  metadata: {},
  requiresPasswordReset: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
}

const testTokens: AuthTokens = {
  accessToken: 'access-tok',
  refreshToken: 'refresh-tok',
  expiresIn: 900,
}

function makeAuthService(overrides?: Partial<AuthService>): AuthService {
  return {
    register: vi.fn().mockResolvedValue({ customer: testCustomer, tokens: testTokens }),
    login: vi.fn().mockResolvedValue({ customer: testCustomer, tokens: testTokens }),
    refresh: vi.fn().mockResolvedValue({ ...testTokens, accessToken: 'new-access-tok' }),
    logout: vi.fn().mockResolvedValue(undefined),
    verifyAccessToken: vi.fn().mockResolvedValue({ sub: 'cust-1', email: 'test@example.com', roles: ['customer'] }),
    importCustomer: vi.fn().mockResolvedValue(testCustomer),
    ...overrides,
  }
}

describe('POST /api/auth/register', () => {
  it('returns 400 when email is missing', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService())

    const resp = await invoke('POST', '/api/auth/register', {
      body: { password: 'pass123' },
    })
    expect(resp.status).toBe(400)
    const body = resp.body as { error: { code: string } }
    expect(body.error.code).toBe('auth.invalid_input')
  })

  it('returns 400 when password is missing', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService())

    const resp = await invoke('POST', '/api/auth/register', {
      body: { email: 'test@example.com' },
    })
    expect(resp.status).toBe(400)
  })

  it('registers user and returns customer and accessToken', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service)

    const resp = await invoke('POST', '/api/auth/register', {
      body: { email: 'new@example.com', password: 'pass123' },
    })
    expect(resp.status).toBe(201)
    const body = resp.body as { data: { customer: Customer; accessToken: string; expiresIn: number } }
    expect(body.data.customer.email).toBe('test@example.com')
    expect(body.data.accessToken).toBe('access-tok')
    expect(body.data.expiresIn).toBe(900)
  })

  it('sets refresh token cookie on register', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService())

    const resp = await invoke('POST', '/api/auth/register', {
      body: { email: 'new@example.com', password: 'pass123' },
    })
    const refreshCookie = (resp.cookies as Array<{ name: string; value: string; httpOnly: boolean }> | undefined)?.find(
      (c) => c.name === 'nymbal.refresh',
    )
    expect(refreshCookie).toBeTruthy()
    expect(refreshCookie?.value).toBe('refresh-tok')
    expect(refreshCookie?.httpOnly).toBe(true)
  })

  it('passes optional firstName, lastName, phone to register', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service)

    await invoke('POST', '/api/auth/register', {
      body: {
        email: 'new@example.com',
        password: 'pass123',
        firstName: 'Jane',
        lastName: 'Doe',
        phone: '07700900000',
      },
    })
    expect(service.register).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe', phone: '07700900000' }),
    )
  })
})

describe('POST /api/auth/login', () => {
  it('returns 400 when email is missing', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService())

    const resp = await invoke('POST', '/api/auth/login', { body: { password: 'pass123' } })
    expect(resp.status).toBe(400)
  })

  it('returns 400 when password is missing', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService())

    const resp = await invoke('POST', '/api/auth/login', {
      body: { email: 'test@example.com' },
    })
    expect(resp.status).toBe(400)
  })

  it('logs in user and returns customer and accessToken', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service)

    const resp = await invoke('POST', '/api/auth/login', {
      body: { email: 'test@example.com', password: 'pass123' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { customer: Customer; accessToken: string; expiresIn: number } }
    expect(body.data.customer.email).toBe('test@example.com')
    expect(body.data.accessToken).toBe('access-tok')
    expect(service.login).toHaveBeenCalledWith('test@example.com', 'pass123')
  })

  it('sets refresh token cookie on login', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService())

    const resp = await invoke('POST', '/api/auth/login', {
      body: { email: 'test@example.com', password: 'pass123' },
    })
    const refreshCookie = (resp.cookies as Array<{ name: string; value: string }> | undefined)?.find(
      (c) => c.name === 'nymbal.refresh',
    )
    expect(refreshCookie?.value).toBe('refresh-tok')
  })

  it('returns error when auth service throws', async () => {
    const service = makeAuthService({
      login: vi.fn().mockRejectedValue(new Error('invalid credentials')),
    })
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service)

    const resp = await invoke('POST', '/api/auth/login', {
      body: { email: 'bad@example.com', password: 'wrong' },
    })
    expect(resp.status).toBeGreaterThanOrEqual(400)
  })
})

describe('POST /api/auth/refresh', () => {
  it('returns 401 when no refresh token is provided', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService())

    const resp = await invoke('POST', '/api/auth/refresh', { body: {} })
    expect(resp.status).toBe(401)
  })

  it('refreshes token using cookie', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service)

    const resp = await invoke('POST', '/api/auth/refresh', {
      cookies: { 'nymbal.refresh': 'refresh-tok' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { accessToken: string; expiresIn: number } }
    expect(body.data.accessToken).toBe('new-access-tok')
    expect(service.refresh).toHaveBeenCalledWith('refresh-tok')
  })

  it('refreshes token using body refreshToken', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service)

    const resp = await invoke('POST', '/api/auth/refresh', {
      body: { refreshToken: 'refresh-tok' },
    })
    expect(resp.status).toBe(200)
    expect(service.refresh).toHaveBeenCalledWith('refresh-tok')
  })
})

describe('POST /api/auth/logout', () => {
  it('succeeds even with no refresh token (cookie or body)', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service)

    const resp = await invoke('POST', '/api/auth/logout', { body: {} })
    expect(resp.status).toBe(200)
    expect(service.logout).not.toHaveBeenCalled()
  })

  it('calls auth.logout with refresh token from cookie', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service)

    const resp = await invoke('POST', '/api/auth/logout', {
      cookies: { 'nymbal.refresh': 'refresh-tok' },
    })
    expect(resp.status).toBe(200)
    expect(service.logout).toHaveBeenCalledWith('refresh-tok')
  })

  it('clears the refresh token cookie on logout', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService())

    const resp = await invoke('POST', '/api/auth/logout', {
      cookies: { 'nymbal.refresh': 'refresh-tok' },
    })
    const refreshCookie = (resp.cookies as Array<{ name: string; value: string; maxAge: number }> | undefined)?.find(
      (c) => c.name === 'nymbal.refresh',
    )
    expect(refreshCookie?.maxAge).toBe(0)
  })
})
