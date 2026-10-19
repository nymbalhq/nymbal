import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { CSRF_COOKIE, CSRF_HEADER, primedShopper } from '../support/security.js'
import { deliverCapture, orderStatus } from '../support/webhooks.js'

// P1-06 AC-2, AC-3 and AC-4 on a served kernel (SQLite): the double-submit check holds on platform routes, the Stripe
// webhook's `csrf: false` is honoured, and `GET /api/csrf` hands out the cookie's token. Kills: a comparison that
// accepts any header, routes attached to an unguarded adapter, a guard that ignores `RouteOptions.csrf`, a token
// endpoint whose body and cookie disagree or that mints a new token per call.

/** One character changed, same length: a guard comparing lengths only, or presence only, lets it through. */
function oneCharOff(token: string): string {
  const last = token.at(-1)!
  return token.slice(0, -1) + (last === 'a' ? 'b' : 'a')
}

function qtyOf(cart: Pick<Cart, 'items'>, variantId: string): number {
  return cart.items.filter((i) => i.variantId === variantId).reduce((n, i) => n + i.qty, 0)
}

/** The value of the `nymbal.csrf` cookie among `Set-Cookie` headers, if one is set. */
function csrfCookieSet(setCookies: string[]): string | undefined {
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';')
    const at = pair!.indexOf('=')
    if (at > 0 && pair!.slice(0, at).trim() === CSRF_COOKIE) return pair!.slice(at + 1).trim()
  }
  return undefined
}

describe('CSRF guard on platform routes', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  it('AC-2: with the nymbal.csrf cookie and an equal x-csrf-token, POST /api/cart/items adds the item; a header one character off answers 403 csrf.invalid and the cart is unchanged', async () => {
    const seeded = await seedVariant(k, 10)
    const shop = await primedShopper(served.baseUrl)
    const created = await shop.call<Cart>('GET', '/api/cart')
    expect(created.status).toBe(200)
    const qty = 2

    const added = await shop.call<Cart>('POST', '/api/cart/items', {
      variantId: seeded.variantId,
      qty,
    })
    expect(added.status, JSON.stringify(added.body)).toBeGreaterThanOrEqual(200)
    expect(added.status).toBeLessThan(300)
    const before = await shop.call<Cart>('GET', '/api/cart')
    expect(qtyOf(before.body.data!, seeded.variantId)).toBe(
      qtyOf(created.body.data!, seeded.variantId) + qty,
    )

    const token = shop.jar.get(CSRF_COOKIE)!
    const tampered = await shop.call<Cart>(
      'POST',
      '/api/cart/items',
      { variantId: seeded.variantId, qty },
      { headers: { [CSRF_HEADER]: oneCharOff(token) } },
    )
    expect(tampered.status, JSON.stringify(tampered.body)).toBe(403)
    expect(tampered.body.error?.code).toBe('csrf.invalid')

    const after = await shop.call<Cart>('GET', '/api/cart')
    expect(after.body.data!.items).toEqual(before.body.data!.items)
  })

  it('AC-3: a correctly signed Stripe webhook with no CSRF cookie or header is processed (200, order confirmed), on a store that refuses a bare cart write', async () => {
    // The guard must be on for this to mean anything: the same store refuses an unsafe request without a token.
    const bare = await fetch(new URL('/api/cart/items', served.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variantId: 'any', qty: 1 }),
    })
    expect(bare.status).toBe(403)

    const seeded = await seedVariant(k, 3)
    const started = await checkoutOf(k, seeded, 1)
    const delivered = await deliverCapture(served.baseUrl, started)
    expect(delivered.status, JSON.stringify(delivered)).toBe(200)
    expect(await orderStatus(raw, started.orderId)).toBe('confirmed')
  })

  it('AC-4: GET /api/csrf with no cookie returns a token equal to the nymbal.csrf cookie it sets; again with that cookie it returns the same token and sets no new cookie', async () => {
    const first = await fetch(new URL('/api/csrf', served.baseUrl), {
      headers: { accept: 'application/json' },
    })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { data: { token: string } }
    const cookie = csrfCookieSet(first.headers.getSetCookie())
    expect(cookie, 'the first call sets the nymbal.csrf cookie').toBeDefined()
    expect(firstBody.data.token).toBe(cookie)
    expect(firstBody.data.token.length).toBeGreaterThan(0)

    const second = await fetch(new URL('/api/csrf', served.baseUrl), {
      headers: { accept: 'application/json', cookie: `${CSRF_COOKIE}=${cookie}` },
    })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { data: { token: string } }
    expect(secondBody.data.token).toBe(firstBody.data.token)
    expect(csrfCookieSet(second.headers.getSetCookie())).toBeUndefined()
  })
})
