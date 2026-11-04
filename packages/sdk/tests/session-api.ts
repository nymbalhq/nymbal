import { vi } from 'vitest'

// A fake store API for the session tests, and Web Storage stand-ins. The API issues access tokens on login, register
// and refresh, accepts only the ones it issued and has not lapsed, and records every request with its bearer. Its
// refresh answers as `refresh` says when the request arrives: `held` waits for `release()`, `hang` never answers.

export const BASE = 'https://api.session.test'
export const HINT = 'nymbal.auth.session'
export const LEGACY_KEY = 'nymbal.auth.accessToken'
export const REFRESH = '/api/auth/refresh'

export type RefreshAnswer =
  | 'works'
  | 'refused'
  | 'forbidden'
  | 'server-error'
  | 'down'
  | 'held'
  | 'hang'

export interface Sent {
  method: string
  path: string
  bearer: string | null
}

export const CUSTOMER = {
  id: 'cus-session',
  email: 'ada@session.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
}

const address = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  addressLine1: '1 Analytical Row',
  city: 'London',
  region: 'Greater London',
  postalCode: 'E1 6AN',
  country: 'GB',
}
export const CHECKOUT_DETAILS = {
  email: CUSTOMER.email,
  billingAddress: address,
  shippingAddress: address,
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const refusal = (status: number, code: string) =>
  json(status, { error: { code, message: `refused: ${code}` } })

export interface SessionApi {
  sent: Sent[]
  /** How the next refresh is answered; a test may change it between requests. */
  refresh: RefreshAnswer
  /** The access token lifetime the API hands out, in seconds. */
  expiresIn: number
  /** Makes the next issued token this one (a property's generated token); otherwise `tok-<n>`. */
  mint: (() => string) | null
  /** Every access token issued, in order. */
  issued: string[]
  lapse(token: string): void
  /** Lets every held refresh answer, as `works`. */
  release(): void
  /** Resolves once `n` refresh requests have arrived. */
  untilRefreshes(n: number): Promise<void>
  refreshes(): number
  bearersTo(path: string): Array<string | null>
  /** Requests to these paths are answered only once a refresh request has arrived. */
  answerAfterRefresh: Set<string>
}

export function fakeSessionApi(): SessionApi {
  const valid = new Set<string>()
  let released: () => void = () => {}
  let releasedGate = new Promise<void>((resolve) => {
    released = resolve
  })
  const waiters: Array<{ n: number; wake: () => void }> = []
  const api: SessionApi = {
    sent: [],
    refresh: 'works',
    expiresIn: 900,
    mint: null,
    issued: [],
    lapse: (token) => {
      valid.delete(token)
    },
    release: () => {
      released()
      releasedGate = Promise.resolve()
    },
    untilRefreshes: (n) =>
      api.refreshes() >= n
        ? Promise.resolve()
        : new Promise<void>((wake) => {
            waiters.push({ n, wake })
          }),
    refreshes: () => api.sent.filter((s) => s.path === REFRESH).length,
    bearersTo: (path) => api.sent.filter((s) => s.path === path).map((s) => s.bearer),
    answerAfterRefresh: new Set(),
  }

  const issue = () => {
    const token = api.mint?.() ?? `tok-${api.issued.length + 1}`
    api.issued.push(token)
    valid.add(token)
    return token
  }
  const isValid = (bearer: string | null) =>
    bearer !== null && valid.has(bearer.replace(/^Bearer /, ''))

  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-token' } })
    const bearer = new Headers(init.headers).get('authorization')
    api.sent.push({ method, path: url.pathname, bearer })

    if (url.pathname === REFRESH) {
      for (const w of waiters.filter((w) => api.refreshes() >= w.n)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.wake()
      }
      const answer = api.refresh
      if (answer === 'hang') return new Promise<Response>(() => {})
      if (answer === 'down') throw new TypeError('Failed to fetch')
      if (answer === 'refused') return refusal(401, 'auth.refresh_invalid')
      if (answer === 'forbidden') return refusal(403, 'auth.refresh_reused')
      if (answer === 'server-error') return refusal(500, 'internal')
      if (answer === 'held') await releasedGate
      return json(200, { data: { accessToken: issue(), expiresIn: api.expiresIn } })
    }
    if (api.answerAfterRefresh.has(url.pathname)) await api.untilRefreshes(1)

    switch (url.pathname) {
      case '/api/auth/login':
      case '/api/auth/register':
        return json(url.pathname === '/api/auth/register' ? 201 : 200, {
          data: { customer: CUSTOMER, accessToken: issue(), expiresIn: api.expiresIn },
        })
      case '/api/auth/logout':
        return json(200, { data: { ok: true } })
      case '/api/customers/me':
        return isValid(bearer) ? json(200, { data: CUSTOMER }) : refusal(401, 'auth.token_invalid')
      case '/api/customers/me/addresses':
        return isValid(bearer) ? json(200, { data: [] }) : refusal(401, 'auth.unauthorized')
      case '/api/recently-viewed':
        return new Response(null, { status: 204 })
      case '/api/cart':
        return json(200, { data: { items: [], subtotalMinor: 0, currency: 'GBP' } })
      case '/api/checkout': {
        const customer = isValid(bearer)
        return json(200, {
          data: {
            orderId: 'ord-1',
            orderNumber: customer ? 'NYM-CUSTOMER' : 'NYM-GUEST',
            paymentIntent: { id: 'pi_1', clientSecret: 's', amountMinor: 1999, currency: 'GBP' },
            currency: 'GBP',
            totalMinor: 1999,
            orderStatus: 'confirmed',
            payment: { status: 'succeeded' },
            ...(!customer && { orderKey: 'guest-key' }),
          },
        })
      }
      default:
        return json(404, { error: { code: 'not_found', message: url.pathname } })
    }
  })
  return api
}

export interface Storages {
  local: Map<string, string>
  session: Map<string, string>
  /** Every key and value in either storage that contains `text`. */
  holding(text: string): string[]
}

function storageOf(items: Map<string, string>, throwing: boolean): Storage {
  const guard = <T>(fn: () => T): T => {
    if (throwing) throw new DOMException('The operation is insecure.', 'SecurityError')
    return fn()
  }
  return {
    getItem: (key: string) => guard(() => items.get(key) ?? null),
    setItem: (key: string, value: string) => guard(() => void items.set(key, String(value))),
    removeItem: (key: string) => guard(() => void items.delete(key)),
    clear: () => guard(() => items.clear()),
    key: (i: number) => guard(() => [...items.keys()][i] ?? null),
    get length() {
      return guard(() => items.size)
    },
  }
}

/** Both Web Storage areas, as a browser page has them; `throwing` makes every call throw, as a locked-down browser's. */
export function stubStorages(
  opts: { local?: Record<string, string>; throwing?: boolean } = {},
): Storages {
  const local = new Map(Object.entries(opts.local ?? {}))
  const session = new Map<string, string>()
  vi.stubGlobal('localStorage', storageOf(local, opts.throwing === true))
  vi.stubGlobal('sessionStorage', storageOf(session, opts.throwing === true))
  return {
    local,
    session,
    holding: (text) =>
      [...local, ...session].flat().filter((entry) => text !== '' && entry.includes(text)),
  }
}

/** Lets every request and answer already under way run its course: turns of the event loop, never a clock. */
export async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Ends a run's stubs. A request a failed run left in flight then hangs rather than reaching the network: the fetch
 * client looks `fetch` up when it sends, so the real one would be called.
 */
export function endStubs(): void {
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
}
