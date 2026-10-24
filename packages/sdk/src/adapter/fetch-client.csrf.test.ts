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
