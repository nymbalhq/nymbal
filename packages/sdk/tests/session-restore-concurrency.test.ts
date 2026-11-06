import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resumeSession } from '../src/core.js'
import { createNymbalClient, type NymbalClient } from '../src/index.js'
import {
  BASE,
  CHECKOUT_DETAILS,
  CUSTOMER,
  endStubs,
  fakeSessionApi,
  HINT,
  REFRESH,
  settle,
  stubStorages,
  type SessionApi,
} from './session-api.js'

// AC-7: one refresh in flight per client. Every restore() called while it is in flight, a request the API refused
// 401 meanwhile and the access-token timer all share it: the API sees one POST /api/auth/refresh, every restore()
// resolves signed in, and the refused request is sent again once with the new token. While restore()'s own refresh is
// in flight, the page's first requests (a recently-viewed record, the cart's load, a checkout), even sent in the same
// tick as restore(), wait for it and go with its token, never as a guest; a refused or unanswered restore lets each go
// once without a bearer, no later than the client's refresh bound (10 s), and resolves signed out.

const REFRESH_WAIT_MS = 10_000

const clients: NymbalClient[] = []
const made = (): NymbalClient => {
  const client = createNymbalClient({ baseUrl: BASE })
  clients.push(client)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
  vi.useRealTimers()
  endStubs()
  vi.restoreAllMocks()
})

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

/** A page's first requests, by the path each sends. */
const FIRST_REQUESTS = {
  '/api/recently-viewed': (client: NymbalClient) => client.recentlyViewed.record('prod-1'),
  '/api/cart': (client: NymbalClient) => client.cart.load(),
  '/api/checkout': (client: NymbalClient) => client.adapter.checkout.create(CHECKOUT_DETAILS),
} as const
type FirstPath = keyof typeof FIRST_REQUESTS
const FIRST_PATHS = Object.keys(FIRST_REQUESTS) as FirstPath[]

/** What reached the API apart from the CSRF token and the refresh itself. */
const others = (api: SessionApi) => api.sent.filter((s) => s.path !== REFRESH)

describe('AC-7: one refresh per client, shared by restore(), the 401 path and the timer', () => {
  // Kills: each restore() refreshing on its own (rotating the session twice per page), or a 401 that arrives during
  // restore's refresh starting another.
  it('AC-7: property: k = 1-5 restore() calls and a request refused 401 while restore’s refresh is in flight make one POST /api/auth/refresh; every restore resolves signed in and the refused request is sent again once with the new token', async () => {
    quiet()
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (k) => {
        stubStorages({ local: { [HINT]: '1' } })
        const api = fakeSessionApi()
        api.refresh = 'held'
        api.answerAfterRefresh.add('/api/customers/me/addresses')
        const client = createNymbalClient({ baseUrl: BASE })
        try {
          const refused = client.customer.addresses.list()
          const restores = Array.from({ length: k }, () => client.auth.restore())
          await api.untilRefreshes(1)
          await settle()
          api.release()
          const outcomes = await Promise.allSettled([refused, ...restores])

          expect(api.refreshes(), `k = ${k}`).toBe(1)
          expect(outcomes.map((o) => o.status)).toEqual(outcomes.map(() => 'fulfilled'))
          expect(client.auth.getState().isAuthenticated).toBe(true)
          expect(api.bearersTo('/api/customers/me/addresses')).toEqual([
            null,
            `Bearer ${api.issued[0]}`,
          ])
        } finally {
          client.destroy()
          endStubs()
        }
      }),
      { numRuns: 10, examples: [[1], [5]] },
    )
  })

  // Kills: the timer refreshing on its own path beside the 401 path's refresh (client.ts:230), so a token that lapses
  // as the timer fires is rotated twice and the second rotation is refused as a reuse.
  it('AC-7: property: whichever of the timer and a 401 starts the refresh, the other and k = 1-5 restore() calls made while it is in flight share it: one POST /api/auth/refresh, every restore signed in, the refused request sent again once with the new token', async () => {
    quiet()
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('timer', '401'),
        fc.integer({ min: 1, max: 5 }),
        async (first, k) => {
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
          stubStorages()
          const api = fakeSessionApi()
          api.expiresIn = 10
          const client = createNymbalClient({ baseUrl: BASE })
          try {
            await client.auth.login(CUSTOMER.email, 'pw')
            const lapsed = api.issued[0]!
            api.lapse(lapsed)
            api.refresh = 'held'

            let refused: Promise<unknown>
            if (first === 'timer') {
              await vi.advanceTimersByTimeAsync(8_000)
              await api.untilRefreshes(1)
              refused = client.customer.addresses.list()
            } else {
              refused = client.customer.addresses.list()
              await api.untilRefreshes(1)
              await vi.advanceTimersByTimeAsync(8_000)
            }
            const restores = Array.from({ length: k }, () => client.auth.restore())
            await settle()
            api.release()
            const outcomes = await Promise.allSettled([refused, ...restores])
            await settle()

            expect(api.refreshes(), `${first} first, k = ${k}`).toBe(1)
            expect(outcomes.map((o) => o.status)).toEqual(outcomes.map(() => 'fulfilled'))
            expect(client.auth.getState().isAuthenticated).toBe(true)
            expect(api.bearersTo('/api/customers/me/addresses')).toEqual([
              `Bearer ${lapsed}`,
              `Bearer ${api.issued[1]}`,
            ])
          } finally {
            client.destroy()
            vi.useRealTimers()
            endStubs()
          }
        },
      ),
      {
        numRuns: 12,
        examples: [
          ['timer', 3],
          ['401', 3],
        ],
      },
    )
  })
})

describe('AC-7: a page’s first requests wait for restore()', () => {
  // Kills: the first POST /api/recently-viewed of a signed-in shopper's page going as a guest (the view filed under a
  // new visitor), or a checkout in the first moment of a reloaded page placed as a guest order.
  it('AC-7: property: any of a recentlyViewed.record, a cart.load and a checkout, sent in the same tick as an unawaited restore(), reach the API only after its refresh, once each, with Authorization: Bearer <the token it issued>', async () => {
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray(FIRST_PATHS, { minLength: 1 }), async (paths) => {
        stubStorages({ local: { [HINT]: '1' } })
        const api = fakeSessionApi()
        api.refresh = 'held'
        const client = createNymbalClient({ baseUrl: BASE })
        try {
          const restored = client.auth.restore()
          const calls = paths.map((path) => FIRST_REQUESTS[path](client))
          await api.untilRefreshes(1)
          await settle()
          const beforeRefresh = others(api).map((s) => s.path)
          api.release()
          await Promise.all([restored, ...calls])

          expect(beforeRefresh, 'sent while the refresh was in flight').toEqual([])
          const token = `Bearer ${api.issued[0]}`
          expect(Object.fromEntries(paths.map((path) => [path, api.bearersTo(path)]))).toEqual(
            Object.fromEntries(paths.map((path) => [path, [token]])),
          )
        } finally {
          client.destroy()
          endStubs()
        }
      }),
      { numRuns: 15, examples: [[[...FIRST_PATHS]]] },
    )
  })

  // Kills: held requests never released when the session has ended (the cart never loads), or sent twice.
  it('AC-7: a restore whose refresh is refused releases every held request once, without Authorization, and resolves signed out', async () => {
    quiet()
    stubStorages({ local: { [HINT]: '1' } })
    const api = fakeSessionApi()
    api.refresh = 'refused'
    const client = made()

    const restored = client.auth.restore()
    const calls = FIRST_PATHS.map((path) => FIRST_REQUESTS[path](client))
    await Promise.allSettled([restored, ...calls])

    expect(Object.fromEntries(FIRST_PATHS.map((path) => [path, api.bearersTo(path)]))).toEqual(
      Object.fromEntries(FIRST_PATHS.map((path) => [path, [null]])),
    )
    expect(api.refreshes()).toBe(1)
    expect(client.auth.getState().isAuthenticated).toBe(false)
  })

  // Kills: a hold with no bound, so an API that never answers the refresh freezes every request the page makes.
  it('AC-7: a restore whose refresh never answers holds the page’s requests until the refresh bound, then releases each once without Authorization and resolves signed out', async () => {
    quiet()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubStorages({ local: { [HINT]: '1' } })
    const api = fakeSessionApi()
    api.refresh = 'hang'
    const client = made()
    let restoreSettled = false

    const restored = client.auth.restore().finally(() => {
      restoreSettled = true
    })
    const calls = FIRST_PATHS.map((path) => FIRST_REQUESTS[path](client))
    await api.untilRefreshes(1)
    await settle()
    const held = { sent: others(api).length, restoreSettled }
    await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS)
    await settle()
    await Promise.allSettled([restored, ...calls])

    expect(held).toEqual({ sent: 0, restoreSettled: false })
    expect(Object.fromEntries(FIRST_PATHS.map((path) => [path, api.bearersTo(path)]))).toEqual(
      Object.fromEntries(FIRST_PATHS.map((path) => [path, [null]])),
    )
    expect(restoreSettled).toBe(true)
    expect(client.auth.getState().isAuthenticated).toBe(false)
  })
})

describe('AC-7: resumeSession, the page’s restore without the auth store', () => {
  // Kills: resumeSession refreshing outside the client's single flight or installing its hold after an await, so the
  // page's cart read goes as a guest and auth.restore() in the same tick sends a second refresh.
  it('AC-7: with the session hint, resumeSession then cart.load and auth.restore in the same tick make one POST /api/auth/refresh, and the cart read goes after it with the token it issued', async () => {
    stubStorages({ local: { [HINT]: '1' } })
    const api = fakeSessionApi()
    api.refresh = 'held'
    const client = made()

    const resumed = resumeSession(client)
    const loaded = client.cart.load()
    const restored = client.auth.restore()
    await api.untilRefreshes(1)
    await settle()
    const beforeRefresh = others(api).map((s) => s.path)
    api.release()
    await Promise.all([resumed, loaded, restored])

    expect(beforeRefresh, 'sent while the refresh was in flight').toEqual([])
    expect(api.refreshes()).toBe(1)
    expect(api.bearersTo('/api/cart')).toEqual([`Bearer ${api.issued[0]}`])
    expect(client.auth.getState().isAuthenticated).toBe(true)
  })

  // Kills: a guest's page sending a refresh on every load.
  it('AC-7: without the session hint, resumeSession sends no request at all', async () => {
    stubStorages()
    const api = fakeSessionApi()
    const client = made()

    await resumeSession(client)
    await settle()

    expect(api.sent).toEqual([])
  })
})
