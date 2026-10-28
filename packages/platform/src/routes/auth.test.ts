import fc from 'fast-check'
import { describe, it, expect, vi } from 'vitest'
import { registerAuthRoutes, type AfterSignIn } from './auth.js'
import {
  AuthError,
  type HttpAdapter,
  type Logger,
  type RouteHandler,
  type Customer,
  type ResponseCookie,
} from '@nymbalhq/types'
import type { AuthService, AuthTokens } from '../services/auth-service.js'

/** A logger that keeps each record's level, so a test can read what a route logged. */
function recordingLogger(records: Array<{ level: string }>): Logger {
  const at =
    (level: string) =>
    (..._args: unknown[]): void => {
      records.push({ level })
    }
  const logger = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }
  return logger as unknown as Logger
}

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
      logger?: Logger
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
      logger: options.logger ?? {
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
  roles: ['customer'],
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
    verifyAccessToken: vi
      .fn()
      .mockResolvedValue({ sub: 'cust-1', email: 'test@example.com', roles: ['customer'] }),
    importCustomer: vi.fn().mockResolvedValue(testCustomer),
    ...overrides,
  }
}

describe('POST /api/auth/register', () => {
  it('registers user and returns customer and accessToken', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service, '7d')

    const resp = await invoke('POST', '/api/auth/register', {
      body: { email: 'new@example.com', password: 'pass123' },
    })
    expect(resp.status).toBe(201)
    const body = resp.body as {
      data: { customer: Customer; accessToken: string; expiresIn: number }
    }
    expect(body.data.customer.email).toBe('test@example.com')
    expect(body.data.accessToken).toBe('access-tok')
    expect(body.data.expiresIn).toBe(900)
  })

  it('sets refresh token cookie on register', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService(), '7d')

    const resp = await invoke('POST', '/api/auth/register', {
      body: { email: 'new@example.com', password: 'pass123' },
    })
    const refreshCookie = (
      resp.cookies as Array<{ name: string; value: string; httpOnly: boolean }> | undefined
    )?.find((c) => c.name === 'nymbal.refresh')
    expect(refreshCookie).toBeTruthy()
    expect(refreshCookie?.value).toBe('refresh-tok')
    expect(refreshCookie?.httpOnly).toBe(true)
  })
})

describe('POST /api/auth/login', () => {
  it('logs in user and returns customer and accessToken', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service, '7d')

    const resp = await invoke('POST', '/api/auth/login', {
      body: { email: 'test@example.com', password: 'pass123' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as {
      data: { customer: Customer; accessToken: string; expiresIn: number }
    }
    expect(body.data.customer.email).toBe('test@example.com')
    expect(body.data.accessToken).toBe('access-tok')
    expect(service.login).toHaveBeenCalledWith('test@example.com', 'pass123')
  })

  it('sets refresh token cookie on login', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService(), '7d')

    const resp = await invoke('POST', '/api/auth/login', {
      body: { email: 'test@example.com', password: 'pass123' },
    })
    const refreshCookie = (
      resp.cookies as Array<{ name: string; value: string }> | undefined
    )?.find((c) => c.name === 'nymbal.refresh')
    expect(refreshCookie?.value).toBe('refresh-tok')
  })

  it('returns error when auth service throws', async () => {
    const service = makeAuthService({
      login: vi.fn().mockRejectedValue(new Error('invalid credentials')),
    })
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service, '7d')

    const resp = await invoke('POST', '/api/auth/login', {
      body: { email: 'bad@example.com', password: 'wrong' },
    })
    expect(resp.status).toBeGreaterThanOrEqual(400)
  })
})

describe('POST /api/auth/refresh', () => {
  it('returns 401 when no refresh token is provided', async () => {
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService(), '7d')

    const resp = await invoke('POST', '/api/auth/refresh', { body: {} })
    expect(resp.status).toBe(401)
  })

  it('refreshes token using cookie', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service, '7d')

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
    registerAuthRoutes(adapter, service, '7d')

    const resp = await invoke('POST', '/api/auth/refresh', {
      body: { refreshToken: 'refresh-tok' },
    })
    expect(resp.status).toBe(200)
    expect(service.refresh).toHaveBeenCalledWith('refresh-tok')
  })
})

describe('the refresh cookie', () => {
  const SECONDS_PER_UNIT = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 } as const

  // Kills: a Max-Age that ignores the configured refresh TTL, so the cookie outlives (or dies before) the token it carries.
  it('lives exactly the configured refresh TTL, in seconds, on register, login and refresh', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 90 }),
        fc.constantFrom(...(Object.keys(SECONDS_PER_UNIT) as (keyof typeof SECONDS_PER_UNIT)[])),
        async (qty, unit) => {
          const { adapter, invoke } = makeAdapter()
          registerAuthRoutes(adapter, makeAuthService(), `${qty}${unit}`)
          const credentials = { email: 'test@example.com', password: 'pass123' }
          const responses = [
            await invoke('POST', '/api/auth/register', { body: credentials }),
            await invoke('POST', '/api/auth/login', { body: credentials }),
            await invoke('POST', '/api/auth/refresh', {
              cookies: { 'nymbal.refresh': 'refresh-tok' },
            }),
          ]
          const maxAges = responses.map(
            (resp) =>
              (resp.cookies as { name: string; maxAge: number }[] | undefined)?.find(
                (c) => c.name === 'nymbal.refresh',
              )?.maxAge,
          )
          const ttlSeconds = qty * SECONDS_PER_UNIT[unit]
          expect(maxAges).toEqual([ttlSeconds, ttlSeconds, ttlSeconds])
        },
      ),
    )
  })
})

describe('POST /api/auth/logout', () => {
  it('succeeds even with no refresh token (cookie or body)', async () => {
    const service = makeAuthService()
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, service, '7d')

    const resp = await invoke('POST', '/api/auth/logout', { body: {} })
    expect(resp.status).toBe(200)
    expect(service.logout).not.toHaveBeenCalled()
  })

  it('logout expires the very cookie login set: same name and path, empty, with a Max-Age of 0 where login’s was positive', async () => {
    type Cookie = { name: string; value: string; path?: string; maxAge: number }
    const refreshOf = (resp: { cookies?: unknown }) =>
      (resp.cookies as Cookie[] | undefined)?.find((c) => c.name === 'nymbal.refresh')
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService(), '7d')

    const set = refreshOf(
      await invoke('POST', '/api/auth/login', {
        body: { email: 'test@example.com', password: 'pass123' },
      }),
    )!
    const cleared = refreshOf(
      await invoke('POST', '/api/auth/logout', { cookies: { 'nymbal.refresh': set.value } }),
    )!

    expect([cleared.name, cleared.path]).toEqual([set.name, set.path])
    expect(cleared.value).toBe('')
    expect(cleared.maxAge).toBe(0)
    expect(cleared.maxAge).toBeLessThan(set.maxAge)
  })
})

describe('AC-6: the after-sign-in hooks', () => {
  const credentials = { email: 'test@example.com', password: 'pass123' }
  const SIGN_INS = [
    { path: '/api/auth/login', status: 200 },
    { path: '/api/auth/register', status: 201 },
  ] as const

  /** Hooks that record their run and answer one cookie each, or throw where `fails` says. */
  function hooksOf(fails: boolean[]) {
    const ran: string[] = []
    const cookieOf = (i: number, customerId: string): ResponseCookie => ({
      name: `hook.${i}`,
      value: customerId,
      path: '/',
    })
    const hooks: AfterSignIn[] = fails.map((fail, i) => async (_ctx, customerId) => {
      ran.push(`${i}:${customerId}`)
      if (fail) throw new Error(`hook ${i} refused`)
      return [cookieOf(i, customerId)]
    })
    return { hooks, ran, cookieOf }
  }

  const byName = (a: ResponseCookie, b: ResponseCookie) => a.name.localeCompare(b.name)

  it('AC-6: property: login and register run every hook in order with the signed-in customer, send each succeeding hook’s cookies beside the refresh cookie, log each throwing hook at warn, and still answer their success status', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { maxLength: 5 }),
        fc.constantFrom(...SIGN_INS),
        async (fails, signIn) => {
          const { hooks, ran, cookieOf } = hooksOf(fails)
          const records: Array<{ level: string }> = []
          const { adapter, invoke } = makeAdapter()
          registerAuthRoutes(adapter, makeAuthService(), '7d', hooks)

          const resp = await invoke('POST', signIn.path, {
            body: credentials,
            logger: recordingLogger(records),
          })

          expect(resp.status).toBe(signIn.status)
          expect(ran).toEqual(fails.map((_, i) => `${i}:${testCustomer.id}`))
          const cookies = (resp.cookies ?? []) as ResponseCookie[]
          expect(cookies.find((c) => c.name === 'nymbal.refresh')?.value).toBe('refresh-tok')
          expect(cookies.filter((c) => c.name !== 'nymbal.refresh').sort(byName)).toEqual(
            fails.flatMap((fail, i) => (fail ? [] : [cookieOf(i, testCustomer.id)])).sort(byName),
          )
          expect(records.filter((r) => r.level === 'warn').length).toBe(
            fails.filter(Boolean).length,
          )
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-6: a login that succeeds runs the hooks; a refused one after it runs none and sends no hook’s cookie', async () => {
    const { hooks, ran } = hooksOf([false, false])
    const login = vi
      .fn()
      .mockResolvedValueOnce({ customer: testCustomer, tokens: testTokens })
      .mockRejectedValueOnce(new AuthError('invalid_credentials', 'Invalid email or password'))
    const { adapter, invoke } = makeAdapter()
    registerAuthRoutes(adapter, makeAuthService({ login }), '7d', hooks)

    const accepted = await invoke('POST', '/api/auth/login', { body: credentials })
    const ranAfterSuccess = [...ran]
    const refused = await invoke('POST', '/api/auth/login', { body: credentials })

    expect([accepted.status, refused.status]).toEqual([200, 401])
    expect(ranAfterSuccess).toEqual([`0:${testCustomer.id}`, `1:${testCustomer.id}`])
    expect(ran, 'hooks run by the refused login').toEqual(ranAfterSuccess)
    expect(((refused.cookies ?? []) as ResponseCookie[]).map((c) => c.name)).toEqual([])
  })
})
