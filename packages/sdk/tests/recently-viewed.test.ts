import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNymbalApiAdapter,
  createNymbalClient,
  FetchClient,
  type CommerceAdapter,
} from '../src/index.js'

// AC-12's client side: `client.recentlyViewed.record(id)` sends `POST /api/recently-viewed { productId }` with the
// CSRF header and the browser's credentials and resolves with nothing (the API answers 204 with no body);
// `list()` resolves the API's items. An adapter of a project's own may leave `recentlyViewed` out: it still compiles,
// and the client then rejects both calls with an Error rather than throwing where they are made.

const API = 'http://api.test'

interface Seen {
  method: string
  path: string
  csrf: string | null
  credentials: RequestCredentials | undefined
  body: unknown
}

const ITEMS = [
  { id: 'p-2', slug: 'two', name: 'Two', status: 'active' },
  { id: 'p-1', slug: 'one', name: 'One', status: 'active' },
]

function fakeApi() {
  const seen: Seen[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = (init.method ?? 'GET').toUpperCase()
    seen.push({
      method,
      path: url.pathname,
      csrf: new Headers(init.headers).get('x-csrf-token'),
      credentials: init.credentials,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    if (url.pathname === '/api/csrf') {
      return new Response(JSON.stringify({ data: { token: 'tok-1' } }), { status: 200 })
    }
    if (url.pathname === '/api/recently-viewed' && method === 'POST') {
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/api/recently-viewed' && method === 'GET') {
      return new Response(JSON.stringify({ data: { items: ITEMS } }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }), {
      status: 404,
    })
  })
  return { seen }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AC-12: client.recentlyViewed', () => {
  it('AC-12: record(id) sends POST /api/recently-viewed { productId: id } with the CSRF token GET /api/csrf answered and credentials included, and resolves with nothing', async () => {
    const api = fakeApi()
    const client = createNymbalClient({ baseUrl: API, tokenStorage: 'memory' })

    const answer = await client.recentlyViewed.record('p-7')

    expect(answer).toBeUndefined()
    const posts = api.seen.filter((s) => s.method === 'POST')
    expect(posts).toEqual([
      {
        method: 'POST',
        path: '/api/recently-viewed',
        csrf: 'tok-1',
        credentials: 'include',
        body: { productId: 'p-7' },
      },
    ])
    const csrfAt = api.seen.findIndex((s) => s.path === '/api/csrf')
    expect(csrfAt).toBeLessThan(api.seen.indexOf(posts[0]!))
    client.destroy()
  })

  it('AC-12: list() sends GET /api/recently-viewed with credentials and resolves the items the API answered, in its order', async () => {
    const api = fakeApi()
    const client = createNymbalClient({ baseUrl: API, tokenStorage: 'memory' })

    const listed = await client.recentlyViewed.list()

    expect(listed.items.map((p) => p.id)).toEqual(ITEMS.map((p) => p.id))
    expect(api.seen.filter((s) => s.path === '/api/recently-viewed')).toEqual([
      {
        method: 'GET',
        path: '/api/recently-viewed',
        csrf: null,
        credentials: 'include',
        body: undefined,
      },
    ])
    client.destroy()
  })

  it('AC-12: a client whose adapter has no recentlyViewed rejects record and list with an Error, throws nothing where they are called, and asks the API nothing', async () => {
    const api = fakeApi()
    const { recentlyViewed: _left, ...custom } = createNymbalApiAdapter(
      new FetchClient({ baseUrl: API }),
    )
    // A project's own adapter, typed as the SDK's: it compiles without the optional member.
    const adapter: CommerceAdapter = custom
    const client = createNymbalClient({ baseUrl: API, tokenStorage: 'memory', adapter })
    const asked = api.seen.length

    let calls: Array<Promise<unknown>> = []
    let thrown: unknown = null
    try {
      calls = [client.recentlyViewed.record('p-1'), client.recentlyViewed.list()]
    } catch (error) {
      thrown = error
    }
    const reasons = await Promise.all(
      calls.map((call) =>
        call.then(
          () => 'resolved',
          (e: unknown) => e,
        ),
      ),
    )

    expect(thrown, 'thrown where called').toBeNull()
    expect(reasons.map((r) => r instanceof Error)).toEqual([true, true])
    expect(api.seen.length).toBe(asked)
    client.destroy()
  })

  it('AC-12: a view sent with a stale token while another request’s 401 is being refreshed waits for that one refresh and is sent again with the new token', async () => {
    const seen: Array<{ method: string; path: string; bearer: string | null }> = []
    let refused = 0
    let bothRefused!: () => void
    const twoRefusals = new Promise<void>((resolve) => (bothRefused = resolve))
    const refusal = () => {
      refused += 1
      if (refused === 2) bothRefused()
      return new Response(
        JSON.stringify({ error: { code: 'auth.token_invalid', message: 'stale' } }),
        { status: 401 },
      )
    }
    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      const method = (init.method ?? 'GET').toUpperCase()
      const bearer = new Headers(init.headers).get('authorization')
      seen.push({ method, path: url.pathname, bearer })
      const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
      switch (`${method} ${url.pathname}`) {
        case 'GET /api/csrf':
          return ok({ token: 'tok-1' })
        case 'POST /api/auth/login':
          return ok({ accessToken: 'stale', expiresIn: 900, customer: { id: 'c-1' } })
        case 'POST /api/auth/refresh':
          // Held until both requests are refused, then for a task, so the second refusal is handled while the
          // refresh the first one started is still in flight.
          await twoRefusals
          await new Promise((resolve) => setTimeout(resolve, 0))
          return ok({ accessToken: 'fresh', expiresIn: 900 })
        case 'GET /api/customers/me':
          return bearer === 'Bearer fresh' ? ok({ id: 'c-1', email: 'c@e2e.test' }) : refusal()
        case 'POST /api/recently-viewed':
          return bearer === 'Bearer fresh' ? new Response(null, { status: 204 }) : refusal()
        default:
          return new Response(null, { status: 404 })
      }
    })
    const client = createNymbalClient({ baseUrl: API, tokenStorage: 'memory' })
    await client.auth.login('c@e2e.test', 'pw')
    seen.length = 0

    // As a page load does: the session's profile read and the page's view, both with the stale token.
    const [, recorded] = await Promise.all([
      client.auth.loadProfile(),
      client.recentlyViewed.record('p-7'),
    ])

    expect(recorded).toBeUndefined()
    expect(client.auth.getState().customer?.email).toBe('c@e2e.test')
    expect(seen.filter((s) => s.path === '/api/auth/refresh')).toHaveLength(1)
    expect(
      seen
        .filter((s) => s.path === '/api/recently-viewed' || s.path === '/api/customers/me')
        .map((s) => `${s.method} ${s.path} ${s.bearer}`)
        .sort(),
    ).toEqual(
      [
        'GET /api/customers/me Bearer stale',
        'GET /api/customers/me Bearer fresh',
        'POST /api/recently-viewed Bearer stale',
        'POST /api/recently-viewed Bearer fresh',
      ].sort(),
    )
    client.destroy()
  })

  it('AC-12: a view sent with the stale token after another request’s refresh has begun, and refused before it ends, waits for it and is sent again once with the new token', async () => {
    const seen: Array<{ method: string; path: string; bearer: string | null }> = []
    let refreshBegan!: () => void
    const began = new Promise<void>((resolve) => (refreshBegan = resolve))
    let viewRefused!: () => void
    const refused = new Promise<void>((resolve) => (viewRefused = resolve))
    const refusal = () =>
      new Response(JSON.stringify({ error: { code: 'auth.token_invalid', message: 'stale' } }), {
        status: 401,
      })
    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      const method = (init.method ?? 'GET').toUpperCase()
      const bearer = new Headers(init.headers).get('authorization')
      seen.push({ method, path: url.pathname, bearer })
      const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
      switch (`${method} ${url.pathname}`) {
        case 'GET /api/csrf':
          return ok({ token: 'tok-1' })
        case 'POST /api/auth/login':
          return ok({ accessToken: 'stale', expiresIn: 900, customer: { id: 'c-1' } })
        case 'POST /api/auth/refresh':
          // Held until the view sent after it began has been refused, then for a task, so that refusal is handled
          // while this refresh is still in flight.
          refreshBegan()
          await refused
          await new Promise((resolve) => setTimeout(resolve, 0))
          return ok({ accessToken: 'fresh', expiresIn: 900 })
        case 'GET /api/customers/me':
          return bearer === 'Bearer fresh' ? ok({ id: 'c-1', email: 'c@e2e.test' }) : refusal()
        case 'POST /api/recently-viewed':
          if (bearer === 'Bearer fresh') return new Response(null, { status: 204 })
          viewRefused()
          return refusal()
        default:
          return new Response(null, { status: 404 })
      }
    })
    const client = createNymbalClient({ baseUrl: API, tokenStorage: 'memory' })
    await client.auth.login('c@e2e.test', 'pw')
    seen.length = 0

    // The session's profile read is refused first and starts the refresh; the page's view is sent only after that.
    const profile = client.auth.loadProfile()
    await began
    const recorded = await client.recentlyViewed.record('p-7')
    await profile

    expect(recorded).toBeUndefined()
    expect(seen.filter((s) => s.path === '/api/auth/refresh')).toHaveLength(1)
    expect(
      seen
        .filter((s) => s.path === '/api/recently-viewed')
        .map((s) => `${s.method} ${s.path} ${s.bearer}`),
    ).toEqual(['POST /api/recently-viewed Bearer stale', 'POST /api/recently-viewed Bearer fresh'])
    client.destroy()
  })
})
