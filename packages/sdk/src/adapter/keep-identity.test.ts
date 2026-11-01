import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient, type NymbalClient } from '../client.js'
import { NymbalApiError } from './fetch-client.js'

// A signed-in shopper's checkout begin, sent with an access token the API no longer accepts (401 auth.token_invalid),
// through the client the templates build (`tokenStorage: 'localStorage'`, so the stale token survived a page load).
// When the refresh works, the begin is sent again as the customer. When the refresh is refused (the session has
// ended), the begin is thrown with its 401 rather than sent again with no bearer, where the API would place a guest
// order the shopper never sees in their account. A request without `keepIdentity` (a catalogue read) is sent again
// with no bearer, as it always was.

const BASE = 'https://api.identity.test'
const TOKEN_KEY = 'nymbal.auth.accessToken'
const STALE = 'stale-access-token'
const FRESH = 'fresh-access-token'
const CUSTOMER_ORDER = 'NYM-CUSTOMER'
const GUEST_ORDER = 'NYM-GUEST'
const HANG = 2_000

const address = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  addressLine1: '1 Analytical Row',
  city: 'London',
  region: 'Greater London',
  postalCode: 'E1 6AN',
  country: 'GB',
}
const details = { email: 'ada@identity.test', billingAddress: address, shippingAddress: address }

interface Sent {
  method: string
  path: string
  bearer: string | null
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const tokenInvalid = () =>
  json(401, { error: { code: 'auth.token_invalid', message: 'the access token is not valid' } })

/**
 * A fake API. A request with the stale bearer is refused; the checkout begin places the customer's order with the
 * fresh bearer and a guest's with none; the refresh answers as `refresh` says. The first request to each path in
 * `together` is answered only once every one of them has been sent, so they are all in flight when the token lapses.
 */
function fakeApi(opts: { refresh: 'works' | 'refused'; together?: string[] }) {
  const sent: Sent[] = []
  const together = new Set(opts.together ?? [])
  let allSent: () => void = () => {}
  const barrier = new Promise<void>((resolve) => {
    allSent = resolve
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-token' } })
    const bearer = new Headers(init.headers).get('authorization')
    const first = !sent.some((s) => s.path === url.pathname)
    sent.push({ method, path: url.pathname, bearer })
    if (first && together.has(url.pathname)) {
      if ([...together].every((path) => sent.some((s) => s.path === path))) allSent()
      await barrier
    }
    if (url.pathname === '/api/auth/refresh') {
      return opts.refresh === 'works'
        ? json(200, { data: { accessToken: FRESH, expiresIn: 900 } })
        : json(401, { error: { code: 'auth.refresh_invalid', message: 'the session has ended' } })
    }
    if (bearer === `Bearer ${STALE}`) return tokenInvalid()
    const customer = bearer === `Bearer ${FRESH}`
    if (url.pathname === '/api/checkout') {
      const orderNumber = customer ? CUSTOMER_ORDER : GUEST_ORDER
      return json(200, {
        data: {
          orderId: `id-${orderNumber}`,
          orderNumber,
          paymentIntent: { id: 'pi_1', clientSecret: 's', amountMinor: 1999, currency: 'GBP' },
          currency: 'GBP',
          totalMinor: 1999,
          orderStatus: 'confirmed',
          payment: { status: 'succeeded' },
          ...(!customer && { orderKey: 'guest-key' }),
        },
      })
    }
    if (url.pathname === '/api/orders') {
      return json(200, { data: customer ? [{ orderNumber: CUSTOMER_ORDER }] : [], meta: {} })
    }
    return json(200, { data: { slug: 'widget', name: 'Widget' } })
  })
  return {
    sent,
    bearersTo: (path: string) => sent.filter((s) => s.path === path).map((s) => s.bearer),
    refreshes: () => sent.filter((s) => s.path === '/api/auth/refresh').length,
  }
}

/** The templates' client, its stored access token already stale. */
function staleClient(): { client: NymbalClient; stored: () => string | null } {
  const items = new Map<string, string>([[TOKEN_KEY, STALE]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, String(value)),
    removeItem: (key: string) => items.delete(key),
    clear: () => items.clear(),
    key: (i: number) => [...items.keys()][i] ?? null,
    get length() {
      return items.size
    },
  })
  const client = createNymbalClient({ baseUrl: BASE, tokenStorage: 'localStorage' })
  clients.push(client)
  return { client, stored: () => items.get(TOKEN_KEY) ?? null }
}

const clients: NymbalClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const settled = (call: Promise<unknown>) =>
  call.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  )

describe('a checkout begin sent with a lapsed access token', () => {
  it(
    'AC-6: when the refresh works, the begin is refused once, the token refreshed once, and the begin sent again with the new token places the customer’s order',
    async () => {
      const api = fakeApi({ refresh: 'works' })
      const { client, stored } = staleClient()

      const result = await client.adapter.checkout.create(details)

      expect(result.orderNumber).toBe(CUSTOMER_ORDER)
      expect(api.bearersTo('/api/checkout')).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`])
      expect(api.refreshes()).toBe(1)
      expect(stored()).toBe(FRESH)
    },
    HANG,
  )

  it(
    'AC-6: a second request in flight when the token lapses shares the one refresh, and both are sent again with the new token and answered as the customer',
    async () => {
      const api = fakeApi({ refresh: 'works', together: ['/api/checkout', '/api/orders'] })
      const { client } = staleClient()

      const [placed, orders] = await Promise.all([
        client.adapter.checkout.create(details),
        client.customer.orders.list(),
      ])

      expect(api.refreshes()).toBe(1)
      expect(api.bearersTo('/api/checkout')).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`])
      // Both sent with the same bearers, in the same order: the one refresh's token went to each.
      expect(api.bearersTo('/api/orders')).toEqual(api.bearersTo('/api/checkout'))
      expect(orders.items.map((o) => o.orderNumber)).toEqual([placed.orderNumber])
    },
    HANG,
  )

  it(
    'AC-7: when the refresh is refused, the begin is sent once and thrown with its 401 auth.token_invalid, never sent again without a bearer; a catalogue read without keepIdentity is still sent again without one',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const api = fakeApi({ refresh: 'refused' })
      const signedIn = staleClient()

      const begin = await settled(signedIn.client.adapter.checkout.create(details))

      expect(begin.value, 'no order came back').toBeUndefined()
      expect(begin.error).toBeInstanceOf(NymbalApiError)
      const refused = begin.error as NymbalApiError
      expect([refused.status, refused.code]).toEqual([401, 'auth.token_invalid'])
      expect(api.bearersTo('/api/checkout'), 'the begin, as sent').toEqual([`Bearer ${STALE}`])
      expect(api.refreshes()).toBe(1)

      const browsing = staleClient()
      const product = await browsing.client.adapter.products.getBySlug('widget')

      expect(product.slug).toBe('widget')
      expect(api.bearersTo('/api/products/widget')).toEqual([`Bearer ${STALE}`, null])
      expect(api.refreshes()).toBe(2)
    },
    HANG,
  )

  it(
    'AC-7: a begin and a catalogue read in flight together when the session has ended: one refresh, the begin thrown with its 401 after one send, the read sent again without a bearer',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const api = fakeApi({
        refresh: 'refused',
        together: ['/api/checkout', '/api/products/widget'],
      })
      const { client } = staleClient()

      const [begin, read] = await Promise.all([
        settled(client.adapter.checkout.create(details)),
        settled(client.adapter.products.getBySlug('widget')),
      ])

      expect(api.refreshes()).toBe(1)
      expect(api.bearersTo('/api/checkout'), 'the begin, as sent').toEqual([`Bearer ${STALE}`])
      expect(begin.error).toBeInstanceOf(NymbalApiError)
      expect((begin.error as NymbalApiError).code).toBe('auth.token_invalid')
      expect(read.error).toBeUndefined()
      expect(api.bearersTo('/api/products/widget')).toEqual([`Bearer ${STALE}`, null])
    },
    HANG,
  )
})
