import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchClient, NymbalApiError } from './fetch-client.js'

// AC-8: the SDK fetches a CSRF token from `GET /api/csrf` before its first unsafe request, caches it, sends it as
// `x-csrf-token` on POST/PUT/PATCH/DELETE only, and on a 403 `csrf.invalid` refetches once and retries once.

const BASE = 'https://api.security.test'

interface Call {
  method: string
  path: string
  csrf: string | null
}

/**
 * A fake API: `GET /api/csrf` hands out `tok-1`, `tok-2`, ...; every other request answers from `answer`, which sees
 * the request and how many non-csrf requests came before it.
 */
function fakeApi(answer: (call: Call, index: number) => { status: number; body: unknown }) {
  const calls: Call[] = []
  const issued: string[] = []
  let others = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = (init.method ?? 'GET').toUpperCase()
    const call = { method, path: url.pathname, csrf: new Headers(init.headers).get('x-csrf-token') }
    calls.push(call)
    if (url.pathname === '/api/csrf') {
      const token = `tok-${issued.length + 1}`
      issued.push(token)
      return new Response(JSON.stringify({ data: { token } }), { status: 200 })
    }
    const out = answer(call, others)
    others += 1
    return new Response(JSON.stringify(out.body), { status: out.status })
  })
  return { calls, issued }
}

const ok = () => ({ status: 200, body: { data: { ok: true } } })
const csrfInvalid = () => ({
  status: 403,
  body: { error: { code: 'csrf.invalid', message: 'Invalid or missing CSRF token' } },
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FetchClient CSRF', () => {
  it('AC-8: the first POST is preceded by exactly one GET /api/csrf; POST, PATCH and DELETE carry that token, GET carries none, and a second POST reuses it', async () => {
    const api = fakeApi(ok)
    const client = new FetchClient({ baseUrl: BASE })

    await client.request('GET', '/api/products')
    await client.request('POST', '/api/cart/items', { variantId: 'v', qty: 1 })
    await client.request('PATCH', '/api/cart/items/v', { qty: 2 })
    await client.request('DELETE', '/api/cart/items/v')
    await client.request('POST', '/api/cart/items', { variantId: 'w', qty: 1 })
    await client.request('GET', '/api/cart')

    const csrfFetches = api.calls.filter((c) => c.path === '/api/csrf')
    expect(csrfFetches).toHaveLength(1)
    expect(api.issued).toHaveLength(1)
    const firstUnsafe = api.calls.findIndex((c) => c.method !== 'GET')
    expect(api.calls.findIndex((c) => c.path === '/api/csrf')).toBe(firstUnsafe - 1)

    const others = api.calls.filter((c) => c.path !== '/api/csrf')
    const gets = others.filter((c) => c.method === 'GET')
    const unsafe = others.filter((c) => c.method !== 'GET')
    expect(unsafe.map((c) => c.method)).toEqual(['POST', 'PATCH', 'DELETE', 'POST'])
    expect(gets.map((c) => c.csrf)).toEqual(gets.map(() => null))
    expect(unsafe.map((c) => c.csrf)).toEqual(unsafe.map(() => api.issued[0]))
  })

  it('AC-8: on a 403 csrf.invalid it fetches a fresh token once and retries the request once with it', async () => {
    const api = fakeApi((_call, index) => (index === 0 ? csrfInvalid() : ok()))
    const client = new FetchClient({ baseUrl: BASE })

    await expect(client.request('POST', '/api/cart/items', { variantId: 'v' })).resolves.toEqual({
      ok: true,
    })

    const posts = api.calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(api.issued).toHaveLength(2)
    expect(posts[0]!.csrf).toBe(api.issued[0])
    expect(posts[1]!.csrf).toBe(api.issued[1])
  })

  it('AC-8: a second 403 csrf.invalid throws NymbalApiError with status 403 after exactly 2 POSTs', async () => {
    const api = fakeApi(csrfInvalid)
    const client = new FetchClient({ baseUrl: BASE })

    const error = await client.request('POST', '/api/cart/items', { variantId: 'v' }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(NymbalApiError)
    expect((error as NymbalApiError).status).toBe(403)
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2)
    expect(api.issued).toHaveLength(2)
  })
})

// A 401 refreshes once and the request is sent again once; a refresh that is itself refused, as it is for a shopper
// whose session has lapsed, must neither recurse nor wait on itself. The refresh goes through the same client, marked
// as the refresh, and a refused one is swallowed, as `createNymbalClient` wires it.
describe('FetchClient 401 refresh', () => {
  const HANG = 2_000
  const refused = () => ({
    status: 401,
    body: { error: { code: 'auth.token_invalid', message: 'expired' } },
  })

  /** `marked: false` is a refresh of a project's own that leaves out `{ authRefresh: true }`. */
  function refreshingClient(marked = true) {
    let token = 'stale'
    let runs = 0
    const client: FetchClient = new FetchClient({
      baseUrl: BASE,
      getAccessToken: () => token,
      onUnauthorized: async () => {
        runs += 1
        try {
          token = (
            await client.request<{ accessToken: string }>(
              'POST',
              '/api/auth/refresh',
              undefined,
              marked ? { authRefresh: true } : {},
            )
          ).accessToken
        } catch {
          // As the client's: a refused refresh leaves the session signed out.
        }
      },
    })
    return { client, runs: () => runs }
  }

  const rejection = (call: Promise<unknown>) =>
    call.then(
      () => undefined,
      (e: unknown) => e,
    )

  it(
    'a refresh that is itself refused runs once, starts no second refresh, and the request is thrown with the 401',
    async () => {
      const api = fakeApi(refused)
      const { client, runs } = refreshingClient()

      const error = await rejection(client.request('GET', '/api/customers/me'))

      expect(error).toBeInstanceOf(NymbalApiError)
      expect((error as NymbalApiError).status).toBe(401)
      expect(runs()).toBe(1)
      expect(api.calls.filter((c) => c.path !== '/api/csrf').map((c) => c.path)).toEqual([
        '/api/customers/me',
        '/api/auth/refresh',
        '/api/customers/me',
      ])
    },
    HANG,
  )

  it(
    'a request sent again after a refresh that worked and refused again is thrown, after exactly one refresh',
    async () => {
      const api = fakeApi((call) =>
        call.path === '/api/auth/refresh'
          ? { status: 200, body: { data: { accessToken: 'fresh', expiresIn: 900 } } }
          : refused(),
      )
      const { client, runs } = refreshingClient()

      const error = await rejection(client.request('GET', '/api/customers/me'))

      expect(error).toBeInstanceOf(NymbalApiError)
      expect((error as NymbalApiError).status).toBe(401)
      expect(runs()).toBe(1)
      expect(api.calls.filter((c) => c.path === '/api/auth/refresh')).toHaveLength(1)
      expect(api.calls.filter((c) => c.path === '/api/customers/me')).toHaveLength(2)
    },
    HANG,
  )

  it(
    'requests refused together share one refresh, and when it is refused every one of them is thrown with the 401',
    async () => {
      const paths = ['/api/customers/me', '/api/cart', '/api/recently-viewed']
      const api = fakeApi(refused)
      const { client, runs } = refreshingClient()

      // All three are sent before any answer is read, so each 401 is seen while the first one's refresh is in flight.
      const errors = await Promise.all(paths.map((path) => rejection(client.request('GET', path))))

      expect(errors.map((e) => e instanceof NymbalApiError && e.status)).toEqual([401, 401, 401])
      expect(runs()).toBe(1)
      expect(api.calls.filter((c) => c.path === '/api/auth/refresh')).toHaveLength(1)
      for (const path of paths) {
        expect(
          api.calls.filter((c) => c.path === path),
          path,
        ).toHaveLength(2)
      }
    },
    HANG,
  )

  it(
    'a refresh of its own that is not marked and is refused cuts the wait off at 10 s, and the request is thrown with the 401',
    async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        fakeApi(refused)
        const { client, runs } = refreshingClient(false)
        let settled = false
        const error = rejection(client.request('GET', '/api/customers/me')).finally(() => {
          settled = true
        })

        await vi.advanceTimersByTimeAsync(9_999)
        expect(settled, 'still waiting on the refresh before the bound').toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(settled, 'settled at the bound').toBe(true)
        expect(await error).toBeInstanceOf(NymbalApiError)
        expect(((await error) as NymbalApiError).status).toBe(401)
        expect(runs()).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    },
    HANG,
  )
})
