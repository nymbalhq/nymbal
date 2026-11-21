import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient } from '../index.js'
import { NymbalApiError } from './fetch-client.js'

// The SDK's password calls: asking for a reset link, setting a password with one, and changing it while signed in.
// Each posts its fields in the body, never in a URL (a proxy's access log keeps URLs). A reset and a change answer as a
// sign-in does, so the client holds the new access token and is signed in as the customer the API answered, exactly as
// after `login`. A refusal of either is a 400, never a session matter: it starts no refresh.

const BASE = 'https://api.password.test'
const FORGOT = '/api/auth/forgot-password'
const RESET = '/api/auth/reset-password'
const CHANGE = '/api/customers/me/password'
const LOGIN = '/api/auth/login'
const REFRESH = '/api/auth/refresh'

interface Sent {
  method: string
  url: URL
  headers: Headers
  body: string
}

const customerOf = (email: string) => ({
  id: `cus-${email.length}`,
  email,
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '',
  addresses: [],
  orderCount: 0,
  totalSpentMinor: 0,
  metadata: {},
  roles: ['customer'],
  requiresPasswordReset: false,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
})

interface Api {
  sent: Sent[]
  /** The access token each sign-in answer (login, reset, change) carried, in order. */
  issued: string[]
}

/**
 * A fake API that records each request: a sign-in, a reset and a change answer the login envelope with a fresh access
 * token, or the refusal `refuse` names (400); the profile read answers the customer; the CSRF read answers a token.
 */
function recordingApi(email: string, refuse: Partial<Record<string, string>> = {}): Api {
  const sent: Sent[] = []
  const issued: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    sent.push({
      method: init.method ?? 'GET',
      url,
      headers: new Headers(init.headers),
      body: String(init.body ?? ''),
    })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-token' } })
    if (url.pathname === FORGOT) return json(202, { data: { sent: 'if-matched' } })
    if (url.pathname === REFRESH)
      return json(200, { data: { accessToken: 'refreshed', expiresIn: 900 } })
    if (url.pathname === '/api/customers/me') return json(200, { data: customerOf(email) })
    const refusal = refuse[url.pathname]
    if (refusal !== undefined) {
      return json(400, { error: { code: refusal, message: `refused: ${refusal}` } })
    }
    if ([LOGIN, RESET, CHANGE].includes(url.pathname)) {
      const accessToken = `access-${issued.length + 1}-${url.pathname.split('/').pop()}`
      issued.push(accessToken)
      return json(200, { data: { customer: customerOf(email), accessToken, expiresIn: 900 } })
    }
    return json(404, { error: { code: 'not_found', message: url.pathname } })
  })
  return { sent, issued }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const email = fc
  .tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.stringMatching(/^[a-z]{1,8}$/))
  .map(([user, host]) => `${user}@${host}.test`)
const token = fc.stringMatching(/^[A-Za-z0-9_-]{43}$/)
const password = fc.stringMatching(/^[A-Za-z0-9]{8,24}$/)

/** Whether `value`, as typed or URL-encoded, is anywhere in the URL. */
const inUrl = (url: URL, value: string) =>
  [value, encodeURIComponent(value)].some((v) => decodeURIComponent(url.href).includes(v))

const apiCalls = (api: Api) => api.sent.filter((s) => s.url.pathname !== '/api/csrf')

describe('AC-22: the SDK’s password calls', () => {
  it('AC-22: property: requestPasswordReset, resetPassword and changePassword each send one request to their path with their fields in the body, and no email, token or password in any URL', async () => {
    await fc.assert(
      fc.asyncProperty(email, token, password, password, async (address, link, current, next) => {
        const api = recordingApi(address)
        const client = createNymbalClient({ baseUrl: BASE })
        try {
          await client.auth.requestPasswordReset(address)
          await client.auth.resetPassword(link, next)
          await client.auth.changePassword(current, next)

          expect(apiCalls(api).map((s) => [s.method, s.url.pathname, JSON.parse(s.body)])).toEqual([
            ['POST', FORGOT, { email: address }],
            ['POST', RESET, { token: link, password: next }],
            ['PATCH', CHANGE, { currentPassword: current, newPassword: next }],
          ])
          expect(
            api.sent.filter((s) => [address, link, current, next].some((v) => inUrl(s.url, v))),
          ).toEqual([])
        } finally {
          client.destroy()
        }
      }),
      { numRuns: 30 },
    )
  })

  it('AC-22: property: after resetPassword, and after changePassword, the client is signed in as the customer answered and its next request carries the answered access token, as after login', async () => {
    await fc.assert(
      fc.asyncProperty(email, token, password, async (address, link, next) => {
        const api = recordingApi(address)
        const viaLogin = createNymbalClient({ baseUrl: BASE })
        const viaReset = createNymbalClient({ baseUrl: BASE })
        const viaChange = createNymbalClient({ baseUrl: BASE })
        try {
          await viaLogin.auth.login(address, next)
          const loginState = viaLogin.auth.getState()
          await viaReset.auth.resetPassword(link, next)
          const resetToken = api.issued.at(-1)
          await viaChange.auth.login(address, next)
          await viaChange.auth.changePassword(next, `${next}-new`)
          const changeToken = api.issued.at(-1)
          const before = api.sent.length
          await viaReset.auth.loadProfile()
          await viaChange.auth.loadProfile()

          expect(viaReset.auth.getState()).toEqual(loginState)
          expect(viaChange.auth.getState()).toEqual(loginState)
          expect(
            api.sent
              .slice(before)
              .filter((s) => s.url.pathname === '/api/customers/me')
              .map((s) => s.headers.get('authorization')),
          ).toEqual([`Bearer ${resetToken}`, `Bearer ${changeToken}`])
        } finally {
          viaLogin.destroy()
          viaReset.destroy()
          viaChange.destroy()
        }
      }),
      { numRuns: 20 },
    )
  })

  it('AC-22: a 400 from resetPassword or changePassword rejects with the API’s code and sends no refresh', async () => {
    const api = recordingApi('ada@password.test', {
      [RESET]: 'auth.reset_link_invalid',
      [CHANGE]: 'auth.current_password_invalid',
    })
    const client = createNymbalClient({ baseUrl: BASE })
    try {
      await client.auth.login('ada@password.test', 'correct-horse')
      const codes: unknown[] = []
      for (const call of [
        () => client.auth.resetPassword('a'.repeat(43), 'new-password'),
        () => client.auth.changePassword('wrong-password', 'new-password'),
      ]) {
        try {
          await call()
          codes.push('resolved')
        } catch (error) {
          codes.push(error instanceof NymbalApiError ? [error.status, error.code] : String(error))
        }
      }

      expect(codes).toEqual([
        [400, 'auth.reset_link_invalid'],
        [400, 'auth.current_password_invalid'],
      ])
      expect(api.sent.filter((s) => s.url.pathname === REFRESH)).toEqual([])
    } finally {
      client.destroy()
    }
  })
})
