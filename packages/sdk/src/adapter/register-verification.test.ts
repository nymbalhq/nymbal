import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient } from '../index.js'
import { NymbalApiError } from './fetch-client.js'

// The SDK's sign-up on a store that confirms addresses: a register the store answers 202 "check your email" holds no
// session (no token, not signed in); one it answers 201 signs in as today. Following the mailed link signs in as a
// login does; a refused link is a 400, never a session matter, so it starts no refresh. No token or address rides in a
// URL (a proxy's access log keeps URLs).

const BASE = 'https://api.verify.test'
const REGISTER = '/api/auth/register'
const VERIFY = '/api/auth/verify-email'
const RESEND = '/api/auth/resend-verification'
const LOGIN = '/api/auth/login'
const REFRESH = '/api/auth/refresh'
const SENT = { verification: 'sent', expiresHours: 24 }

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
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
})

interface Api {
  sent: Sent[]
  /** The access token each sign-in answer carried, in order. */
  issued: string[]
}

/**
 * A fake API: register answers 202 SENT under `required` and 201 signed in under `off`; verify-email and login answer
 * the login envelope with a fresh access token, or a 400 when `refuseVerify`; resend answers 202.
 */
function recordingApi(
  email: string,
  opts: { policy: 'required' | 'off'; refuseVerify?: boolean },
): Api {
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
    const signIn = (status: number) => {
      const accessToken = `access-${issued.length + 1}-${url.pathname.split('/').pop()}`
      issued.push(accessToken)
      return json(status, { data: { customer: customerOf(email), accessToken, expiresIn: 900 } })
    }
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-token' } })
    if (url.pathname === REFRESH)
      return json(200, { data: { accessToken: 'refreshed', expiresIn: 900 } })
    if (url.pathname === '/api/customers/me') return json(200, { data: customerOf(email) })
    if (url.pathname === RESEND) return json(202, { data: { sent: 'if-matched' } })
    if (url.pathname === REGISTER)
      return opts.policy === 'required' ? json(202, { data: SENT }) : signIn(201)
    if (url.pathname === VERIFY) {
      if (opts.refuseVerify === true) {
        return json(400, {
          error: { code: 'auth.verify_link_invalid', message: 'This link is no longer valid.' },
        })
      }
      return signIn(200)
    }
    if (url.pathname === LOGIN) return signIn(200)
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

/** The authorization header of the next profile read: the access token the client holds. */
async function heldToken(
  client: ReturnType<typeof createNymbalClient>,
  api: Api,
): Promise<string | null> {
  const before = api.sent.length
  await client.auth.loadProfile()
  return (
    api.sent
      .slice(before)
      .find((s) => s.url.pathname === '/api/customers/me')
      ?.headers.get('authorization') ?? null
  )
}

describe('AC-16: a register the store answers 202 holds no session', () => {
  // Defect: the store shows a signed-in shell with no session after a register.
  it('AC-16: property: on a 202, customers.register returns { verification: sent, expiresHours: 24 } and AuthStore.register returns verification-sent, holds no token and leaves isAuthenticated false; on a 201 it returns signed-in and holds the answered token, as after login', async () => {
    await fc.assert(
      fc.asyncProperty(email, password, async (address, secret) => {
        const confirming = recordingApi(address, { policy: 'required' })
        const adapterClient = createNymbalClient({ baseUrl: BASE })
        const storeClient = createNymbalClient({ baseUrl: BASE })
        try {
          const answered = await adapterClient.adapter.customers.register({
            email: address,
            password: secret,
          })
          const outcome = await storeClient.auth.register({ email: address, password: secret })
          const state = storeClient.auth.getState()
          const held = await heldToken(storeClient, confirming)

          expect(answered).toEqual(SENT)
          expect([outcome, state.isAuthenticated, state.customer, held]).toEqual([
            'verification-sent',
            false,
            null,
            null,
          ])
        } finally {
          adapterClient.destroy()
          storeClient.destroy()
        }

        const open = recordingApi(address, { policy: 'off' })
        const viaRegister = createNymbalClient({ baseUrl: BASE })
        const viaLogin = createNymbalClient({ baseUrl: BASE })
        try {
          const outcome = await viaRegister.auth.register({ email: address, password: secret })
          const registerToken = open.issued.at(-1)
          await viaLogin.auth.login(address, secret)

          expect(outcome).toBe('signed-in')
          expect(viaRegister.auth.getState()).toEqual(viaLogin.auth.getState())
          expect(await heldToken(viaRegister, open)).toBe(`Bearer ${registerToken}`)
        } finally {
          viaRegister.destroy()
          viaLogin.destroy()
        }
      }),
      { numRuns: 20 },
    )
  })
})

describe('AC-16: following the link signs in as a login does', () => {
  // Defect: verifyEmail leaves the client signed out, or holds a stale token.
  it('AC-16: property: after verifyEmail the client is signed in as after login and its next request carries the answered token; verifyEmail and resendVerification each post their field in the body, and no token or address is in any URL', async () => {
    await fc.assert(
      fc.asyncProperty(email, token, password, async (address, link, secret) => {
        const api = recordingApi(address, { policy: 'required' })
        const viaLogin = createNymbalClient({ baseUrl: BASE })
        const viaVerify = createNymbalClient({ baseUrl: BASE })
        try {
          await viaLogin.auth.login(address, secret)
          await viaVerify.auth.resendVerification(address)
          await viaVerify.auth.verifyEmail(link)
          const verifyToken = api.issued.at(-1)

          expect(viaVerify.auth.getState()).toEqual(viaLogin.auth.getState())
          expect(await heldToken(viaVerify, api)).toBe(`Bearer ${verifyToken}`)
          expect(
            api.sent
              .filter((s) => [RESEND, VERIFY].includes(s.url.pathname))
              .map((s) => [s.method, s.url.pathname, JSON.parse(s.body)]),
          ).toEqual([
            ['POST', RESEND, { email: address }],
            ['POST', VERIFY, { token: link }],
          ])
          expect(
            api.sent.filter((s) => [address, link, secret].some((v) => inUrl(s.url, v))),
          ).toEqual([])
        } finally {
          viaLogin.destroy()
          viaVerify.destroy()
        }
      }),
      { numRuns: 20 },
    )
  })

  // Defect: a refused link starts a refresh, as a 401 would.
  it('AC-16: a 400 from verifyEmail rejects with auth.verify_link_invalid, leaves the client signed out, and sends no refresh', async () => {
    const api = recordingApi('ada@verify.test', { policy: 'required', refuseVerify: true })
    const client = createNymbalClient({ baseUrl: BASE })
    try {
      let refusal: unknown = 'resolved'
      try {
        await client.auth.verifyEmail('a'.repeat(43))
      } catch (error) {
        refusal = error instanceof NymbalApiError ? [error.status, error.code] : String(error)
      }

      expect(refusal).toEqual([400, 'auth.verify_link_invalid'])
      expect(client.auth.getState().isAuthenticated).toBe(false)
      expect(api.sent.filter((s) => s.url.pathname === REFRESH)).toEqual([])
    } finally {
      client.destroy()
    }
  })
})
