import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  bearer,
  bearerOf,
  freshShop,
  lapsedToken,
  liftedViewLimit,
  record,
  registeredCustomer,
  rowsOf,
  setCookieOf,
  UUID,
  viewsInLog,
  VISITOR_COOKIE,
  type Customer,
} from '../support/recently-viewed.js'

// AC-3 on a served kernel (SQLite): `POST /api/recently-viewed { productId }` records one `product.viewed.v1` for an
// active product, viewed by the bearer's customer, else the `nymbal.visitor` cookie's visitor, else a visitor minted
// by this answer (an HttpOnly, SameSite=Lax, 30-day cookie, Secure in production). Unknown and draft products, bots and
// a bearer that decodes to no auth record nothing and mint nothing; no view writes an audit entry.

const THIRTY_DAYS = 30 * 86_400

describe('AC-3: POST /api/recently-viewed captures a view (sqlite)', () => {
  let served: ServedKernel
  let raw: RawReader
  let active: string
  let draft: string
  let customer: Customer

  beforeAll(async () => {
    const kernel = await createKernel({ dialect: 'sqlite', configure: liftedViewLimit })
    served = await serveKernel(kernel)
    raw = openRaw(kernel.dialect, kernel.target)
    active = (await seedVariant(kernel, 5)).productId
    const tag = randomUUID()
    draft = (
      await kernel.services.product.create({
        slug: `draft-${tag}`,
        name: 'Draft Widget',
        description: '',
        status: 'draft',
        variants: [
          {
            sku: `DRAFT-${tag}`,
            name: 'Default',
            priceMinor: 900,
            stock: 3,
            lowStockThreshold: 0,
            options: [],
          },
        ],
      })
    ).id
    customer = await registeredCustomer(kernel)
  }, 60_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await raw?.close()
    await served?.stop()
  })

  it('AC-3(a): a guest with no cookie gets 204 and an HttpOnly, SameSite=Lax, Path=/, 30-day nymbal.visitor holding a UUID, not Secure outside production; the log gains one product.viewed.v1 by that visitor of the body’s product', async () => {
    const shop = await freshShop(served.baseUrl)
    const before = await viewsInLog(raw)

    const res = await record(shop, active)

    expect(res.status).toBe(204)
    const cookie = setCookieOf(res, VISITOR_COOKIE)
    expect(cookie?.value ?? '', 'the minted visitor id').toMatch(UUID)
    expect(cookie?.attributes).toMatchObject({
      httponly: true,
      samesite: expect.stringMatching(/^lax$/i),
      path: '/',
      'max-age': String(THIRTY_DAYS),
    })
    expect(cookie?.attributes['secure'], 'Secure outside production').toBeUndefined()
    const after = await viewsInLog(raw)
    expect(after.length).toBe(before.length + 1)
    expect(after.at(-1)).toMatchObject({
      productId: active,
      viewer: { kind: 'visitor', id: cookie?.value },
    })
  })

  it('AC-3(a): with NODE_ENV=production the minted nymbal.visitor is Secure', async () => {
    const shop = await freshShop(served.baseUrl)
    vi.stubEnv('NODE_ENV', 'production')
    let res: Awaited<ReturnType<typeof record>>
    try {
      res = await record(shop, active)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(res.status).toBe(204)
    expect(setCookieOf(res, VISITOR_COOKIE)?.attributes['secure']).toBe(true)
  })

  it('AC-3(b): a guest holding the cookie gets the same value re-set, 30 days again, and its next view is by the same visitor', async () => {
    const shop = await freshShop(served.baseUrl)
    const first = setCookieOf(await record(shop, active), VISITOR_COOKIE)
    expect(first?.value ?? '').toMatch(UUID)

    const again = await record(shop, active)
    const reset = setCookieOf(again, VISITOR_COOKIE)

    expect(again.status).toBe(204)
    expect(reset?.value).toBe(first?.value)
    expect(reset?.attributes['max-age']).toBe(String(THIRTY_DAYS))
    const views = await viewsInLog(raw)
    expect(views.at(-1)?.viewer).toEqual({ kind: 'visitor', id: first?.value })
    expect(views.filter((v) => v.viewer.id === first?.value).length).toBe(2)
  })

  it('AC-3(c): with a bearer the view is the customer’s and no nymbal.visitor is set, even when the jar holds one', async () => {
    const shop = await freshShop(served.baseUrl)
    await record(shop, active)
    const visitor = shop.jar.get(VISITOR_COOKIE)
    expect(visitor ?? '', 'the jar holds a visitor cookie').toMatch(UUID)
    const token = await bearerOf(served.baseUrl, shop.jar, customer)
    const before = await viewsInLog(raw)

    const res = await record(shop, active, bearer(token))

    expect(res.status).toBe(204)
    expect(setCookieOf(res, VISITOR_COOKIE)).toBeUndefined()
    const after = await viewsInLog(raw)
    expect(after.length).toBe(before.length + 1)
    expect(after.at(-1)).toMatchObject({
      productId: active,
      viewer: { kind: 'customer', id: customer.id },
    })
  })

  it('AC-3(d): an unknown product id and a draft product’s id answer 204, log nothing and set no cookie', async () => {
    const before = await viewsInLog(raw)
    for (const productId of [randomUUID(), draft]) {
      const res = await record(await freshShop(served.baseUrl), productId)
      expect(res.status, productId).toBe(204)
      expect(setCookieOf(res, VISITOR_COOKIE), productId).toBeUndefined()
    }
    expect((await viewsInLog(raw)).length).toBe(before.length)
  })

  it('AC-3(e): a crawler’s User-Agent answers 204, logs nothing and sets no cookie', async () => {
    const before = await viewsInLog(raw)
    for (const agent of [
      'Googlebot/2.1 (+http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'Mozilla/5.0 (compatible; Yahoo! Slurp)',
      'Baiduspider/2.0',
      'SomeCrawler/1.0',
    ]) {
      const res = await record(await freshShop(served.baseUrl), active, { 'user-agent': agent })
      expect(res.status, agent).toBe(204)
      expect(setCookieOf(res, VISITOR_COOKIE), agent).toBeUndefined()
    }
    expect((await viewsInLog(raw)).length).toBe(before.length)
  })

  it('AC-3(f): a nymbal.visitor that is not a UUID is replaced by a fresh one, and the view is by the fresh visitor', async () => {
    const shop = await freshShop(served.baseUrl)
    shop.jar.set(VISITOR_COOKIE, 'not-a-uuid')

    const res = await record(shop, active)

    expect(res.status).toBe(204)
    const fresh = setCookieOf(res, VISITOR_COOKIE)?.value ?? ''
    expect(fresh).toMatch(UUID)
    expect(fresh).not.toBe('not-a-uuid')
    expect((await viewsInLog(raw)).at(-1)?.viewer).toEqual({ kind: 'visitor', id: fresh })
  })

  it('AC-3(g): a recorded view writes no audit entry', async () => {
    const shop = await freshShop(served.baseUrl)
    const audits = await rowsOf(raw, 'audit_entries')
    const views = (await viewsInLog(raw)).length

    const res = await record(shop, active)

    expect(res.status).toBe(204)
    expect((await viewsInLog(raw)).length).toBe(views + 1)
    expect(await rowsOf(raw, 'audit_entries')).toBe(audits)
  })

  it('AC-3(h): a body without productId is refused with 400 and logs nothing', async () => {
    const before = (await viewsInLog(raw)).length
    const res = await record(await freshShop(served.baseUrl), undefined)
    expect(res.status).toBe(400)
    expect((await viewsInLog(raw)).length).toBe(before)
  })

  it('AC-3(i): an expired bearer and one signed with another secret answer 401 auth.token_invalid, log nothing and set no cookie; after a refresh the same view with the new token is the customer’s', async () => {
    const shop = await freshShop(served.baseUrl)
    await bearerOf(served.baseUrl, shop.jar, customer)
    const before = (await viewsInLog(raw)).length

    for (const how of ['expired', 'foreign'] as const) {
      const res = await record(
        shop,
        active,
        bearer(await lapsedToken(served.kernel, customer, how)),
      )
      expect(res.status, how).toBe(401)
      expect(res.body.error?.code, how).toBe('auth.token_invalid')
      expect(setCookieOf(res, VISITOR_COOKIE), how).toBeUndefined()
    }
    expect((await viewsInLog(raw)).length).toBe(before)

    const refreshed = await shop.call<{ accessToken: string }>('POST', '/api/auth/refresh', {})
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200)
    const retried = await record(shop, active, bearer(refreshed.body.data!.accessToken))

    expect(retried.status).toBe(204)
    const after = await viewsInLog(raw)
    expect(after.length).toBe(before + 1)
    expect(after.at(-1)).toMatchObject({
      productId: active,
      viewer: { kind: 'customer', id: customer.id },
    })
  })
})
