import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { primedShopper } from '../support/security.js'
import type { CookieJar, ShopResponse } from '../support/shopper.js'

// The cart routes over HTTP on a served kernel (SQLite): the quantity ceiling and unknown keys refused at the
// boundary, the guest cart merged into the customer's at login and register, a foreign cart cookie expired at
// sign-in, and the cart cookie expired at logout.

const CART_COOKIE = 'nymbal.cart'
const PASSWORD = 'cart-correct-horse'

interface Issue {
  path: unknown
  message: string
}

type Shop = Awaited<ReturnType<typeof primedShopper>>

let k: Kernel
let served: ServedKernel

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
}, 60_000)

afterAll(async () => {
  await served?.stop()
})

/** The `nymbal.cart` a response sets, with its Max-Age when it carries one. */
function cartCookieOf(res: ShopResponse<unknown>): { value: string; maxAge?: number } | undefined {
  const header = res.setCookies.find((c) => c.startsWith(`${CART_COOKIE}=`))
  if (header === undefined) return undefined
  const [pair, ...attributes] = header.split(';')
  const maxAge = attributes
    .map((a) => a.trim().split('='))
    .find(([name]) => name!.toLowerCase() === 'max-age')?.[1]
  return {
    value: pair!.slice(CART_COOKIE.length + 1),
    ...(maxAge !== undefined && { maxAge: Number(maxAge) }),
  }
}

/** What a browser keeps after a response: a cookie set with Max-Age 0 is gone. */
function forgetExpired(jar: CookieJar, res: ShopResponse<unknown>): void {
  for (const header of res.setCookies) {
    if (!/;\s*max-age=0(;|$)/i.test(header)) continue
    jar.delete(header.slice(0, header.indexOf('=')).trim())
  }
}

async function registered(): Promise<{ id: string; email: string }> {
  const email = `cart-${randomUUID()}@cart.test`
  const { customer } = await k.services.auth.register({ email, password: PASSWORD })
  return { id: customer.id, email }
}

/** A customer's own cart holding these lines, through the cart service. */
async function customerCart(customerId: string, lines: Array<[Seeded, number]>): Promise<Cart> {
  const cart = await k.services.cart.getOrCreate(undefined, customerId)
  let held = cart
  for (const [seeded, qty] of lines) {
    held = await k.services.cart.addItem(cart.token, {
      variantId: seeded.variantId,
      productId: seeded.productId,
      productName: 'Transactional Widget',
      variantName: 'Default',
      priceMinor: seeded.priceMinor,
      imageUrl: '',
      qty,
    })
  }
  return held
}

async function add(shop: Shop, seeded: Seeded, qty: number): Promise<void> {
  const res = await shop.call<Cart>('POST', '/api/cart/items', { variantId: seeded.variantId, qty })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
}

async function cartOf(shop: Shop): Promise<Cart> {
  const res = await shop.call<Cart>('GET', '/api/cart')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

const quantities = (cart: Cart): Array<[string, number]> =>
  cart.items
    .map((i): [string, number] => [i.variantId, i.qty])
    .sort(([a], [b]) => a.localeCompare(b))

const sorted = (pairs: Array<[string, number]>) =>
  [...pairs].sort(([a], [b]) => a.localeCompare(b))

const issuesOf = (res: ShopResponse<unknown>): Issue[] =>
  (res.body.error as { context?: { issues?: Issue[] } } | undefined)?.context?.issues ?? []

const dotted = (path: unknown): string => (Array.isArray(path) ? path.join('.') : String(path))

describe('the cart boundary', () => {
  // Kills: schemas with no max, so a line takes 100 at the boundary.
  it('AC-3: POST /api/cart/items with qty 100 and PATCH /api/cart/items/:variantId with qty 100 each answer 400 validation.failed, and the cart is unchanged', async () => {
    const X = await seedVariant(k, 500)
    const shop = await primedShopper(served.baseUrl)
    await add(shop, X, 2)
    const before = await cartOf(shop)

    const added = await shop.call('POST', '/api/cart/items', { variantId: X.variantId, qty: 100 })
    const patched = await shop.call('PATCH', `/api/cart/items/${X.variantId}`, { qty: 100 })

    expect(
      [added, patched].map((r) => [r.status, r.body.error?.code]),
      JSON.stringify([added.body, patched.body]),
    ).toEqual([
      [400, 'validation.failed'],
      [400, 'validation.failed'],
    ])
    expect(quantities(await cartOf(shop))).toEqual(quantities(before))
  })

  // Kills: bodies that are not strict, so `quantity` is stripped and qty defaults to 1.
  it('AC-4: POST /api/cart/items with { variantId, quantity: 3 } and PATCH with { qty: 2, quantity: 3 } each answer 400 validation.failed with an issue naming quantity, and the cart is unchanged (no line of qty 1 appears)', async () => {
    const X = await seedVariant(k, 500)
    const W = await seedVariant(k, 500)
    const shop = await primedShopper(served.baseUrl)
    await add(shop, X, 4)
    const before = await cartOf(shop)

    const added = await shop.call('POST', '/api/cart/items', { variantId: W.variantId, quantity: 3 })
    const patched = await shop.call('PATCH', `/api/cart/items/${X.variantId}`, {
      qty: 2,
      quantity: 3,
    })

    for (const [label, res] of [
      ['POST', added],
      ['PATCH', patched],
    ] as const) {
      expect([res.status, res.body.error?.code], `${label}: ${JSON.stringify(res.body)}`).toEqual([
        400,
        'validation.failed',
      ])
      const naming = issuesOf(res).filter(
        (i) => /(^|\.)quantity$/.test(dotted(i.path)) || i.message.includes('quantity'),
      )
      expect(naming.length, `${label}: issues ${JSON.stringify(issuesOf(res))}`).toBeGreaterThan(0)
    }
    expect(quantities(await cartOf(shop))).toEqual(quantities(before))
  })
})

describe('the cart at sign-in and sign-out', () => {
  // Kills: nothing calling the merge on login.
  it("AC-8: a guest with lines logs in: the answer sets nymbal.cart to the customer's cart, GET /api/cart with it holds the summed lines and the customer's id, and the guest token no longer serves those lines", async () => {
    const X = await seedVariant(k, 500)
    const Y = await seedVariant(k, 500)
    const customer = await registered()
    const held = await customerCart(customer.id, [[Y, 2]])
    const shop = await primedShopper(served.baseUrl)
    await add(shop, X, 3)
    await add(shop, Y, 1)
    const guest = await cartOf(shop)

    const login = await shop.call('POST', '/api/auth/login', {
      email: customer.email,
      password: PASSWORD,
    })

    expect(login.status, JSON.stringify(login.body)).toBe(200)
    expect(cartCookieOf(login)?.value).toBe(held.token)
    const merged = await cartOf(shop)
    expect([merged.token, merged.customerId]).toEqual([held.token, customer.id])
    expect(quantities(merged)).toEqual(
      sorted([
        [X.variantId, 3],
        [Y.variantId, 2 + 1],
      ]),
    )
    const elsewhere = await primedShopper(served.baseUrl)
    elsewhere.jar.set(CART_COOKIE, guest.token)
    const servedToGuest = await cartOf(elsewhere)
    expect(servedToGuest.items.filter((i) => guest.items.some((g) => g.variantId === i.variantId))).toEqual(
      [],
    )
  })

  // Kills: nothing calling the merge on register.
  it("AC-8: a guest with lines registers: the answer sets nymbal.cart to that cart, and GET /api/cart with it holds the guest's lines under the new customer's id", async () => {
    const X = await seedVariant(k, 500)
    const shop = await primedShopper(served.baseUrl)
    await add(shop, X, 2)
    const guest = await cartOf(shop)

    const reg = await shop.call<{ customer: { id: string } }>('POST', '/api/auth/register', {
      email: `cart-${randomUUID()}@cart.test`,
      password: PASSWORD,
    })

    expect(reg.status, JSON.stringify(reg.body)).toBe(201)
    expect(cartCookieOf(reg)?.value).toBe(guest.token)
    const attached = await cartOf(shop)
    expect([attached.token, attached.customerId]).toEqual([guest.token, reg.body.data!.customer.id])
    expect(quantities(attached)).toEqual(quantities(guest))
  })

  // Kills: a cookie for a cart the customer cannot have outliving the sign-in, or A's cart handed to or folded into B.
  it("AC-8: customer B (no cart) logs in carrying customer A's cart cookie: the answer expires nymbal.cart, and A's cart is unchanged", async () => {
    const X = await seedVariant(k, 500)
    const a = await registered()
    const theirs = await customerCart(a.id, [[X, 2]])
    const before = await k.services.cart.get(theirs.token)
    const b = await registered()
    const shop = await primedShopper(served.baseUrl)
    shop.jar.set(CART_COOKIE, theirs.token)

    const login = await shop.call('POST', '/api/auth/login', { email: b.email, password: PASSWORD })

    expect(login.status, JSON.stringify(login.body)).toBe(200)
    expect(cartCookieOf(login)?.maxAge).toBe(0)
    expect(await k.services.cart.get(theirs.token)).toEqual(before)
  })

  // Kills: logout expiring only the refresh and visitor cookies.
  it("AC-11: after logout, GET /api/cart with the cookies logout left creates a new, empty cart, not the customer's", async () => {
    const X = await seedVariant(k, 500)
    const customer = await registered()
    const shop = await primedShopper(served.baseUrl)
    await add(shop, X, 1)
    const login = await shop.call('POST', '/api/auth/login', {
      email: customer.email,
      password: PASSWORD,
    })
    expect(login.status, JSON.stringify(login.body)).toBe(200)
    const signedIn = await cartOf(shop)

    const logout = await shop.call('POST', '/api/auth/logout')
    forgetExpired(shop.jar, logout)

    expect(logout.status, JSON.stringify(logout.body)).toBe(200)
    const after = await cartOf(shop)
    expect(after.token).not.toBe(signedIn.token)
    expect(after.items).toEqual([])
  })
})
