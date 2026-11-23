import { createHash, randomUUID } from 'node:crypto'
import { decodeJwt, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rowsOf as auditRowsOf } from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import type { ShopResponse } from '../support/shopper.js'

// The signed-in devices routes over HTTP, on a SQLite kernel: the list a bearer reads, the end of one session (the
// caller's own or another device's) and the end of every session. Each device is a browser of its own, signed in with
// its own user agent, whose jar holds its refresh cookie. A device's cookie is kept as it was before the route ran,
// so presenting it shows what the server ended, not what the browser forgot.

const REFRESH_COOKIE = 'nymbal.refresh'
const PASSWORD = 'devices-correct-horse'
const SESSION_KEYS = ['current', 'device', 'id', 'lastActiveAt', 'signedInAt']

const FIREFOX_WINDOWS = {
  header: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  label: 'Firefox on Windows',
}
const SAFARI_IPHONE = {
  header:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  label: 'Safari on iPhone',
}

interface Listed {
  id: string
  device: string
  signedInAt: string
  lastActiveAt: string
  current: boolean
}

let s: ServedKernel
let raw: RawReader

beforeAll(async () => {
  s = await serveKernel(await createKernel({ dialect: 'sqlite' }))
  raw = openRaw('sqlite', s.kernel.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await s?.stop()
})

const sidOf = (token: string): unknown => decodeJwt(token)['sid']

/** A customer with no session of its own: registered through the service, whose session is then signed out. */
async function customer() {
  const email = `devices-${randomUUID()}@http.test`
  const registered = await s.kernel.services.auth.register({ email, password: PASSWORD })
  await s.kernel.services.auth.logout(registered.tokens.refreshToken)
  return { id: registered.customer.id, email }
}

/** A browser of its own, signed in over HTTP with `agent` as its user agent. */
async function device(email: string, agent: { header: string }) {
  const shop = await primedShopper(s.baseUrl)
  const login = await shop.call<{ accessToken: string }>(
    'POST',
    '/api/auth/login',
    { email, password: PASSWORD },
    { headers: { 'user-agent': agent.header } },
  )
  expect(login.status, JSON.stringify(login.body)).toBe(200)
  const bearer = login.body.data!.accessToken
  return {
    bearer,
    jar: shop.jar,
    cookie: () => shop.jar.get(REFRESH_COOKIE)!,
    send: <T>(method: string, path: string, token: string | null = bearer) =>
      shop.call<T>(method, path, undefined, {
        headers: {
          'user-agent': agent.header,
          ...(token !== null && { authorization: `Bearer ${token}` }),
        },
      }),
  }
}

/** The status `POST /api/auth/refresh` answers a browser holding `cookie`. */
async function refreshWith(cookie: string): Promise<number> {
  const shop = await primedShopper(s.baseUrl)
  shop.jar.set(REFRESH_COOKIE, cookie)
  return (await shop.call('POST', '/api/auth/refresh')).status
}

/** The cookie names a response expires (`Max-Age=0` or an epoch `Expires`), sorted. */
function expiredNames(setCookies: string[]): string[] {
  return setCookies
    .filter((c) => /max-age=0(;|$)/i.test(c) || /expires=thu, 01 jan 1970/i.test(c))
    .map((c) => c.slice(0, c.indexOf('=')).trim())
    .sort()
}

/** The cookies a sign-out (`POST /api/auth/logout`) expires: what ending this browser's session must match. */
async function signOutExpires(): Promise<string[]> {
  const c = await customer()
  const browser = await device(c.email, FIREFOX_WINDOWS)
  const res = await browser.send('POST', '/api/auth/logout')
  expect(res.status).toBe(200)
  return expiredNames(res.setCookies)
}

/** Whether an audit entry's subjects name the customer. */
const namesCustomer = (subjects: Array<{ type: string; id: string }>, customerId: string): boolean =>
  subjects.some((subject) => subject.type === 'customer' && subject.id === customerId)

/** The audit rows one response's request left for `command`. */
async function auditedAs(headers: Headers, command: string) {
  return (await auditRowsOf(raw, headers.get('x-correlation-id'))).filter(
    (row) => row.command === command,
  )
}

describe('AC-8: GET /api/customers/me/sessions', () => {
  // Defect: the device is never captured from the request; the list leaks a token id, a hash or the raw header; the
  // wrong row (or none) is marked as the caller's.
  it('AC-8: with a bearer, 200 and the service’s list: this device marked current, exactly the five keys, the two user agents as their labels, and no token id, hash or raw header', async () => {
    const c = await customer()
    const firefox = await device(c.email, FIREFOX_WINDOWS)
    const safari = await device(c.email, SAFARI_IPHONE)

    const res = await firefox.send<{ sessions: Listed[] }>('GET', '/api/customers/me/sessions')

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const sessions = res.body.data?.sessions ?? []
    expect(sessions).toEqual(
      await s.kernel.services.auth.listSessions(c.id, sidOf(firefox.bearer) as string),
    )
    expect(sessions.filter((x) => x.current).map((x) => x.id)).toEqual([sidOf(firefox.bearer)])
    expect(sessions.map((x) => Object.keys(x).sort())).toEqual(sessions.map(() => SESSION_KEYS))
    expect(sessions.map((x) => x.device).sort()).toEqual(
      [FIREFOX_WINDOWS.label, SAFARI_IPHONE.label].sort(),
    )
    const text = JSON.stringify(res.body)
    const secrets = [firefox.cookie(), safari.cookie()].flatMap((cookie) => [
      decodeJwt(cookie).jti as string,
      createHash('sha256').update(cookie).digest('hex'),
      cookie,
    ])
    expect(
      [...secrets, FIREFOX_WINDOWS.header, SAFARI_IPHONE.header].filter((x) => text.includes(x)),
    ).toEqual([])
  })

  // Defect: the route answers a guest, or marks a row current from something other than the bearer's sid.
  it('AC-8: with no bearer 401 auth.unauthorized; with an access token that has no sid, 200 and no session marked current', async () => {
    const c = await customer()
    const firefox = await device(c.email, FIREFOX_WINDOWS)
    await device(c.email, SAFARI_IPHONE)
    const now = Math.floor(Date.now() / 1000)
    const noSid = await new SignJWT({
      sub: c.id,
      email: c.email,
      roles: ['customer'],
      type: 'access',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setIssuer('nymbal')
      .setExpirationTime(now + 15 * 60)
      .sign(new TextEncoder().encode(s.kernel.config.security.auth.jwtSecret))

    const anonymous = await firefox.send('GET', '/api/customers/me/sessions', null)
    const old = await firefox.send<{ sessions: Listed[] }>(
      'GET',
      '/api/customers/me/sessions',
      noSid,
    )

    expect([anonymous.status, anonymous.body.error?.code]).toEqual([401, 'auth.unauthorized'])
    expect(old.status, JSON.stringify(old.body)).toBe(200)
    expect((old.body.data?.sessions ?? []).map((x) => x.current)).toEqual([false, false])
  })
})

describe('AC-9: DELETE /api/customers/me/sessions/:id', () => {
  // Defect: ending another device clears this browser's cookies, leaves that device able to renew, takes this one
  // with it, or leaves no trace.
  it('AC-9: for the caller’s other session: 200 { ended: true, current: false }, no cookie of this browser expired, that device’s refresh 401, this one’s 200, one customer.endSession entry naming the customer', async () => {
    const c = await customer()
    const caller = await device(c.email, FIREFOX_WINDOWS)
    const phone = await device(c.email, SAFARI_IPHONE)
    const phoneCookie = phone.cookie()

    const res = await caller.send('DELETE', `/api/customers/me/sessions/${sidOf(phoneCookie)}`)

    expect([res.status, res.body.data]).toEqual([200, { ended: true, current: false }])
    expect(expiredNames(res.setCookies)).toEqual([])
    expect([await refreshWith(phoneCookie), await refreshWith(caller.cookie())]).toEqual([401, 200])
    const audited = await auditedAs(res.headers, 'customer.endSession')
    expect(audited.map((row) => namesCustomer(row.subjects, c.id))).toEqual([true])
  })

  // Defect: ending this browser's own session leaves its dead refresh cookie (and the visitor and cart) behind.
  it('AC-9: for the caller’s own session: 200 { ended: true, current: true }, the cookies a sign-out expires, its refresh 401, one customer.endSession entry', async () => {
    const c = await customer()
    const caller = await device(c.email, FIREFOX_WINDOWS)
    const own = caller.cookie()

    const res = await caller.send('DELETE', `/api/customers/me/sessions/${sidOf(caller.bearer)}`)

    expect([res.status, res.body.data]).toEqual([200, { ended: true, current: true }])
    const expired = expiredNames(res.setCookies)
    expect(expired).toEqual(await signOutExpires())
    expect(expired).toContain(REFRESH_COOKIE)
    expect(await refreshWith(own)).toBe(401)
    expect(await auditedAs(res.headers, 'customer.endSession')).toHaveLength(1)
  })

  // Defect: the answer tells an id of another customer apart from an unknown or ended one (or ends it), or a guest
  // reaches the route.
  it('AC-9: an unknown id, another customer’s session and a session already ended each answer 404 auth.session_not_found with one body; the other customer’s session still refreshes; no bearer 401', async () => {
    const c = await customer()
    const caller = await device(c.email, FIREFOX_WINDOWS)
    const phone = await device(c.email, SAFARI_IPHONE)
    const ended = await caller.send('DELETE', `/api/customers/me/sessions/${sidOf(phone.cookie())}`)
    expect(ended.status).toBe(200)
    const stranger = await customer()
    const theirs = await device(stranger.email, SAFARI_IPHONE)

    const answers: Array<ShopResponse<unknown>> = []
    for (const id of [randomUUID(), sidOf(theirs.cookie()), sidOf(phone.cookie())]) {
      answers.push(await caller.send('DELETE', `/api/customers/me/sessions/${String(id)}`))
    }
    const anonymous = await caller.send(
      'DELETE',
      `/api/customers/me/sessions/${randomUUID()}`,
      null,
    )

    expect(answers.map((a) => [a.status, a.body.error?.code])).toEqual(
      answers.map(() => [404, 'auth.session_not_found']),
    )
    expect(answers.map((a) => a.body)).toEqual(answers.map(() => answers[0]!.body))
    expect(await refreshWith(theirs.cookie())).toBe(200)
    expect(anonymous.status).toBe(401)
  })
})

describe('AC-10: DELETE /api/customers/me/sessions', () => {
  // Defect: signing out everywhere leaves this browser's cookie or another device in, records nothing, or is not safe
  // to repeat (a second call writes or records again).
  it('AC-10: 200 { ended: "all" }, the cookies a sign-out expires, every device’s refresh 401, one customer.endAllSessions entry; a second call answers the same, changes no row and records nothing', async () => {
    const c = await customer()
    const caller = await device(c.email, FIREFOX_WINDOWS)
    const phone = await device(c.email, SAFARI_IPHONE)
    const cookies = [caller.cookie(), phone.cookie()]

    const res = await caller.send('DELETE', '/api/customers/me/sessions')

    expect([res.status, res.body.data]).toEqual([200, { ended: 'all' }])
    expect(expiredNames(res.setCookies)).toEqual(await signOutExpires())
    expect(await Promise.all(cookies.map(refreshWith))).toEqual([401, 401])
    const audited = await auditedAs(res.headers, 'customer.endAllSessions')
    expect(audited.map((row) => namesCustomer(row.subjects, c.id))).toEqual([true])

    const rowsBefore = await raw.rows(
      'SELECT * FROM refresh_tokens WHERE customer_id = ? ORDER BY id',
      [c.id],
    )
    const again = await caller.send('DELETE', '/api/customers/me/sessions')

    expect([again.status, again.body.data]).toEqual([200, { ended: 'all' }])
    expect(
      await raw.rows('SELECT * FROM refresh_tokens WHERE customer_id = ? ORDER BY id', [c.id]),
    ).toEqual(rowsBefore)
    expect(await auditRowsOf(raw, again.headers.get('x-correlation-id'))).toEqual([])
  })
})
