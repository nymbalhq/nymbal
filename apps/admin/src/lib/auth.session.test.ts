import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

// P1-08 AC-6 (unit half) and AC-7: the admin's session client (decision 4). The access token stays in memory; the
// httpOnly `nymbal.refresh` cookie restores it. AC-6 kills: a restore that trusts any refresh, so a customer's cookie
// signs into the admin. AC-7 kills: no retry after a 401; a refresh per failing call (rotation then revokes the whole
// chain, services/auth-service.ts); a refresh loop; a refresh triggered by an /api/auth/* 401.
//
// auth.ts and api.ts keep module state (the token, the CSRF token, the in-flight refresh), so each case loads them
// afresh.

interface Call {
  method: string
  path: string
  authorization: string | null
}

interface FakeOptions {
  /** Status `POST /api/auth/refresh` answers. */
  refreshStatus?: number
  /** Roles behind the refreshed token; `GET /api/admin/me` answers 403 unless they include admin. */
  roles?: string[]
  /** Hold every refresh answer until this many protected calls have been answered 401. */
  holdRefreshUntil401s?: number
}

function fakeApi(options: FakeOptions = {}) {
  const { refreshStatus = 200, roles = ['admin'], holdRefreshUntil401s = 0 } = options
  const calls: Call[] = []
  let refreshes = 0
  let unauthorized = 0
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  if (holdRefreshUntil401s === 0) release()
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const authorization = new Headers(init.headers).get('authorization')
    calls.push({ method, path: url.pathname + url.search, authorization })

    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (url.pathname === '/api/auth/refresh') {
      refreshes += 1
      const n = refreshes
      await released
      if (refreshStatus !== 200) {
        return json(
          { error: { code: 'auth.token_invalid', message: 'refresh refused' } },
          refreshStatus,
        )
      }
      return json({ data: { accessToken: `fresh-${n}`, expiresIn: 900 } })
    }
    if (url.pathname.startsWith('/api/auth/')) {
      return json({ error: { code: 'auth.invalid_credentials', message: 'no' } }, 401)
    }
    if (url.pathname === '/api/admin/me') {
      if (authorization !== 'Bearer fresh-1')
        return json({ error: { code: 'auth.unauthenticated' } }, 401)
      if (!roles.includes('admin'))
        return json({ error: { code: 'auth.forbidden', message: 'Role required: admin' } }, 403)
      return json({ data: { userId: 'u-1', roles, storeName: 'Shop', environment: 'development' } })
    }
    if (url.pathname.startsWith('/api/admin/')) {
      if (authorization === 'Bearer fresh-1') return json({ data: { echo: url.search } })
      unauthorized += 1
      if (unauthorized >= holdRefreshUntil401s) release()
      return json({ error: { code: 'auth.token_expired', message: 'expired' } }, 401)
    }
    return json({ error: { code: 'not_mocked' } }, 404)
  })

  return {
    calls,
    get refreshes() {
      return refreshes
    },
    /** Every call other than the CSRF token fetch, as `METHOD /path?query`. */
    traffic: () => calls.filter((c) => c.path !== '/api/csrf').map((c) => `${c.method} ${c.path}`),
  }
}

async function load() {
  vi.resetModules()
  const auth = await import('@/lib/auth')
  const { api, ApiError } = await import('@/lib/api')
  return { ...auth, api, ApiError }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('P1-08 AC-6: a refresh cookie restores only an admin session', () => {
  it('AC-6: a valid refresh for a customer-role account restores nothing, and the only admin call is the role check', async () => {
    const fake = fakeApi({ roles: ['customer'] })
    const { restoreSession, isAuthenticated } = await load()

    const restored = await restoreSession()

    expect(restored).toBe(false)
    expect(isAuthenticated()).toBe(false)
    expect(fake.refreshes).toBe(1)
    expect(fake.traffic().filter((t) => t.includes(' /api/admin/'))).toEqual(['GET /api/admin/me'])
    const roleCheck = fake.calls.find((c) => c.path === '/api/admin/me')
    expect(roleCheck?.authorization).toBe('Bearer fresh-1')
  })

  it('AC-6: a valid refresh for an admin restores the session with the refreshed token; a refused refresh makes no role check', async () => {
    const admin = fakeApi({ roles: ['admin'] })
    let session = await load()
    expect(await session.restoreSession()).toBe(true)
    expect(session.isAuthenticated()).toBe(true)
    expect(session.getToken()).toBe('fresh-1')
    expect(admin.refreshes).toBe(1)

    vi.unstubAllGlobals()
    const refused = fakeApi({ refreshStatus: 401 })
    session = await load()
    expect(await session.restoreSession()).toBe(false)
    expect(session.isAuthenticated()).toBe(false)
    expect(refused.refreshes).toBe(1)
    expect(refused.traffic().filter((t) => t.includes(' /api/admin/'))).toEqual([])
  })
})

describe('P1-08 AC-7: a 401 causes one shared refresh and one retry', () => {
  it('AC-7: N concurrent calls answered 401 cause exactly one POST /api/auth/refresh, then each is retried once with the new token and resolves (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (n) => {
        vi.unstubAllGlobals()
        const fake = fakeApi({ holdRefreshUntil401s: n })
        const { api, setToken } = await load()
        setToken('expired')

        const results = await Promise.allSettled(
          Array.from({ length: n }, (_, i) =>
            api.get<{ echo: string }>('/api/admin/orders', { i }),
          ),
        )

        expect(fake.refreshes).toBe(1)
        expect(results.map((r) => (r.status === 'fulfilled' ? r.value.echo : r.status))).toEqual(
          Array.from({ length: n }, (_, i) => `?i=${i}`),
        )
        for (let i = 0; i < n; i++) {
          const attempts = fake.calls.filter((c) => c.path === `/api/admin/orders?i=${i}`)
          expect(attempts.map((c) => c.authorization)).toEqual(['Bearer expired', 'Bearer fresh-1'])
        }
      }),
      { numRuns: 15 },
    )
  })

  it('AC-7: concurrent refreshSession() callers share one request and all see its outcome', async () => {
    const fake = fakeApi()
    const { refreshSession, getToken } = await load()

    const outcomes = await Promise.all([refreshSession(), refreshSession(), refreshSession()])

    expect(outcomes).toEqual([true, true, true])
    expect(fake.refreshes).toBe(1)
    expect(getToken()).toBe('fresh-1')
  })

  it('AC-7: a refresh answering 401 leaves the session signed out, fires onSessionLost exactly once and makes no second refresh', async () => {
    const n = 4
    const fake = fakeApi({ refreshStatus: 401, holdRefreshUntil401s: n })
    const { api, setToken, isAuthenticated, onSessionLost, ApiError } = await load()
    let lost = 0
    onSessionLost(() => {
      lost += 1
    })
    setToken('expired')

    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => api.get('/api/admin/orders', { i })),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fake.refreshes).toBe(1)
    expect(lost).toBe(1)
    expect(isAuthenticated()).toBe(false)
    for (const r of results) {
      expect(r.status).toBe('rejected')
      const reason = (r as PromiseRejectedResult).reason as InstanceType<typeof ApiError>
      expect(reason).toBeInstanceOf(ApiError)
      expect(reason.status).toBe(401)
    }
  })

  it('AC-7: a 401 from /api/auth/* never triggers a refresh, while a 401 from an admin route does', async () => {
    const fake = fakeApi()
    const { api, setToken } = await load()
    setToken('expired')

    await expect(
      api.post('/api/auth/login', { email: 'a@b.c', password: 'x' }),
    ).rejects.toMatchObject({ status: 401 })
    await expect(api.post('/api/auth/logout')).rejects.toMatchObject({ status: 401 })
    const afterAuthRoutes = fake.refreshes

    await api.get('/api/admin/orders', { i: 0 })

    expect(afterAuthRoutes).toBe(0)
    expect(fake.refreshes).toBe(afterAuthRoutes + 1)
  })
})

// AC-7b kills: a 401-triggered refresh that adopts whatever token the cookie yields (a customer's cookie on the same
// host) without the role check boot restore makes; a refresh for a call that carried no token at all.
describe('P1-08 AC-7b: every refresh is role-checked', () => {
  it('AC-7b: a 401-triggered refresh that yields a non-admin token signs out, fires onSessionLost once, and the call rejects 401 without a retry', async () => {
    const fake = fakeApi({ roles: ['customer'] })
    const { api, setToken, isAuthenticated, getToken, onSessionLost, ApiError } = await load()
    let lost = 0
    onSessionLost(() => {
      lost += 1
    })
    setToken('admin-expired')
    const signedInBefore = isAuthenticated()

    const result = await api.get('/api/admin/orders', { i: 0 }).then(
      () => null,
      (error: unknown) => error,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(signedInBefore).toBe(true)
    expect(fake.refreshes).toBe(1)
    expect(isAuthenticated()).not.toBe(signedInBefore)
    expect(getToken()).not.toBe('fresh-1')
    expect(lost).toBe(1)
    expect(result).toBeInstanceOf(ApiError)
    expect((result as InstanceType<typeof ApiError>).status).toBe(401)
    const attempts = fake.calls.filter((c) => c.path === '/api/admin/orders?i=0')
    expect(attempts.map((c) => c.authorization)).toEqual(['Bearer admin-expired'])
  })

  it('AC-7b: a 401 for a call sent with no token triggers no refresh, while the same call sent with a token does', async () => {
    const fake = fakeApi()
    const { api, setToken } = await load()

    await expect(api.get('/api/admin/orders', { i: 0 })).rejects.toMatchObject({ status: 401 })
    const afterTokenless = fake.refreshes

    setToken('expired')
    await api.get('/api/admin/orders', { i: 1 })

    expect(afterTokenless).toBe(0)
    expect(fake.refreshes).toBe(afterTokenless + 1)
  })
})
