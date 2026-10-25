import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  bearer,
  expectedList,
  freshShop,
  liftedViewLimit,
  list,
  mergesInLog,
  PASSWORD,
  record,
  registeredCustomer,
  setCookieOf,
  viewsInLog,
  VISITOR_COOKIE,
  type Customer,
  type Shop,
} from '../support/recently-viewed.js'

// AC-6 and AC-7 on a served kernel (SQLite). A sign-in (login or register) carrying a valid `nymbal.visitor` moves
// the visitor's views to the customer: one `visitor.merged.v1`, the cookie expired in the same answer, the customer's
// list the union at each product's newest view, the visitor's list empty. A sign-in with no cookie, or a refused one,
// publishes no merge, and the refused one leaves the cookie. Logout expires the visitor cookie with the refresh cookie;
// the customer's list stays theirs and comes back on the next sign-in.

const MINUTE = 60_000

type Signed = { accessToken: string; customer: { id: string } }

async function signIn(shop: Shop, customer: Customer) {
  return shop.call<Signed>('POST', '/api/auth/login', {
    email: customer.email,
    password: PASSWORD,
  })
}

/** A shopper whose jar holds only the CSRF pair and this visitor cookie. */
async function holding(baseUrl: string, visitorId: string): Promise<Shop> {
  const shop = await freshShop(baseUrl)
  shop.jar.set(VISITOR_COOKIE, visitorId)
  return shop
}

describe('AC-6 and AC-7: the visitor’s views at sign-in and sign-out (sqlite)', () => {
  let s: ServedKernel
  let raw: RawReader
  let catalogue: Record<'A' | 'B' | 'C', string>

  beforeAll(async () => {
    s = await serveKernel(await createKernel({ dialect: 'sqlite', configure: liftedViewLimit }))
    raw = openRaw(s.kernel.dialect, s.kernel.target)
    catalogue = {
      A: (await seedVariant(s.kernel, 3)).productId,
      B: (await seedVariant(s.kernel, 3)).productId,
      C: (await seedVariant(s.kernel, 3)).productId,
    }
  }, 60_000)

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    await raw?.close()
    await s?.stop()
  })

  it('AC-6: on one clock, the customer views C at t and A at t+1m elsewhere, a guest views A at t+2m and B at t+3m, then logs in: 200, the visitor cookie expired, one visitor.merged.v1 { visitorId, customerId }, the customer served B, A, C (A once, at t+2m), the visitor []', async () => {
    const { A, B, C } = catalogue
    const customer = await registeredCustomer(s.kernel)
    const t = Date.now() - 30 * MINUTE
    vi.useFakeTimers({ toFake: ['Date'], now: t })

    const device = await freshShop(s.baseUrl)
    const first = await signIn(device, customer)
    expect(first.status).toBe(200)
    const elsewhere = bearer(first.body.data!.accessToken)
    expect((await record(device, C, elsewhere)).status).toBe(204)
    vi.setSystemTime(t + MINUTE)
    expect((await record(device, A, elsewhere)).status).toBe(204)

    const guest = await freshShop(s.baseUrl)
    vi.setSystemTime(t + 2 * MINUTE)
    expect((await record(guest, A)).status).toBe(204)
    vi.setSystemTime(t + 3 * MINUTE)
    expect((await record(guest, B)).status).toBe(204)
    const visitorId = guest.jar.get(VISITOR_COOKIE)!
    const mergesBefore = await mergesInLog(raw)

    vi.setSystemTime(t + 4 * MINUTE)
    const signedIn = await signIn(guest, customer)

    expect(signedIn.status).toBe(200)
    const expired = setCookieOf(signedIn, VISITOR_COOKIE)
    expect(expired?.value).toBe('')
    expect(expired?.attributes['max-age']).toBe('0')
    const merges = await mergesInLog(raw)
    expect(merges.length).toBe(mergesBefore.length + 1)
    expect(merges.at(-1)).toEqual({ visitorId, customerId: customer.id })

    const views = (await viewsInLog(raw)).filter(
      (v) =>
        (v.viewer.kind === 'customer' && v.viewer.id === customer.id) ||
        (v.viewer.kind === 'visitor' && v.viewer.id === visitorId),
    )
    const served = await list(guest, bearer(signedIn.body.data!.accessToken))
    expect(served.ids).toEqual([B, A, C])
    expect(served.ids).toEqual(expectedList(views))
    expect((await list(await holding(s.baseUrl, visitorId))).ids, 'the visitor’s list').toEqual([])
  })

  it('AC-6: register with a visitor cookie gives the new customer the visitor’s list, and the visitor’s list is empty after', async () => {
    const { A, B } = catalogue
    const guest = await freshShop(s.baseUrl)
    expect((await record(guest, B)).status).toBe(204)
    expect((await record(guest, A)).status).toBe(204)
    const visitorId = guest.jar.get(VISITOR_COOKIE)!
    const before = await list(guest)
    expect(before.ids?.length).toBe(2)
    const mergesBefore = (await mergesInLog(raw)).length

    const registered = await guest.call<Signed>('POST', '/api/auth/register', {
      email: `register-${randomUUID()}@recently-viewed.test`,
      password: PASSWORD,
    })

    expect(registered.status).toBe(201)
    expect(setCookieOf(registered, VISITOR_COOKIE)?.attributes['max-age']).toBe('0')
    const merges = await mergesInLog(raw)
    expect(merges.length).toBe(mergesBefore + 1)
    expect(merges.at(-1)).toEqual({ visitorId, customerId: registered.body.data!.customer.id })
    expect((await list(guest, bearer(registered.body.data!.accessToken))).ids).toEqual(before.ids)
    expect((await list(await holding(s.baseUrl, visitorId))).ids).toEqual([])
  })

  it('AC-6: a login with no visitor cookie and a refused login publish no visitor.merged; the refused one leaves the cookie and the visitor’s list', async () => {
    const { A } = catalogue
    const customer = await registeredCustomer(s.kernel)
    const mergesBefore = (await mergesInLog(raw)).length

    const plain = await signIn(await freshShop(s.baseUrl), customer)
    expect(plain.status).toBe(200)
    expect(setCookieOf(plain, VISITOR_COOKIE)).toBeUndefined()

    const guest = await freshShop(s.baseUrl)
    expect((await record(guest, A)).status).toBe(204)
    const visitorId = guest.jar.get(VISITOR_COOKIE)!
    const listed = await list(guest)
    const refused = await guest.call('POST', '/api/auth/login', {
      email: customer.email,
      password: 'not-the-password',
    })

    expect(refused.status).toBe(401)
    expect(setCookieOf(refused, VISITOR_COOKIE)).toBeUndefined()
    expect(guest.jar.get(VISITOR_COOKIE)).toBe(visitorId)
    expect((await list(guest)).ids).toEqual(listed.ids)
    expect(listed.ids).toEqual([A])
    expect((await mergesInLog(raw)).length).toBe(mergesBefore)
  })

  it('AC-7: logout expires nymbal.visitor beside the refresh cookie; with neither cookie nor bearer the browser is served []; signing in again serves the customer the same list', async () => {
    const { A, B, C } = catalogue
    const customer = await registeredCustomer(s.kernel)
    const shop = await freshShop(s.baseUrl)
    expect((await record(shop, C)).status).toBe(204)
    const signedIn = await signIn(shop, customer)
    expect(signedIn.status).toBe(200)
    const token = bearer(signedIn.body.data!.accessToken)
    expect((await record(shop, B, token)).status).toBe(204)
    expect((await record(shop, A, token)).status).toBe(204)
    const before = await list(shop, token)
    expect(before.ids).toEqual([A, B, C])

    const out = await shop.call('POST', '/api/auth/logout', {}, { headers: token })

    expect(out.status).toBe(200)
    for (const name of [VISITOR_COOKIE, 'nymbal.refresh']) {
      expect(setCookieOf(out, name)?.attributes['max-age'], `${name} expired`).toBe('0')
    }
    const anonymous = await list(shop)
    expect(anonymous.status).toBe(200)
    expect(anonymous.ids).toEqual([])

    const again = await signIn(shop, customer)
    expect(again.status).toBe(200)
    expect((await list(shop, bearer(again.body.data!.accessToken))).ids).toEqual(before.ids)
  })
})
