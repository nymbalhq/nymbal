import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart, Customer } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { login, primedShopper, rolesColumn, tokenRoles } from '../support/security.js'

// P1-06 AC-15 (the cart case), AC-16 and AC-17 over HTTP on a served kernel (SQLite): a negative quantity is refused
// at the boundary with the cart untouched, an undeclared key never reaches the repository, and a checkout the
// shopper can fix answers 409. Kills: validation after the service call, unknown keys passed through, every
// `NymbalError` rendered as 500.

interface Issue {
  path: unknown
  message: string
}

/** An issue path as a dotted string, whether the server sends `['qty']` or `'qty'`. */
function dotted(path: unknown): string {
  return Array.isArray(path) ? path.join('.') : String(path)
}

describe('route input and error mapping over HTTP', () => {
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

  it('AC-15: POST /api/cart/items with qty -1 answers 400 validation.failed with an issue at qty, and the cart is unchanged', async () => {
    const seeded = await seedVariant(k, 10)
    const shop = await primedShopper(served.baseUrl)
    await shop.call<Cart>('GET', '/api/cart')
    const added = await shop.call<Cart>('POST', '/api/cart/items', {
      variantId: seeded.variantId,
      qty: 3,
    })
    expect(added.status, JSON.stringify(added.body)).toBeLessThan(300)
    const before = await shop.call<Cart>('GET', '/api/cart')

    const refused = await shop.call<Cart>('POST', '/api/cart/items', {
      variantId: seeded.variantId,
      qty: -1,
    })
    expect(refused.status, JSON.stringify(refused.body)).toBe(400)
    expect(refused.body.error?.code).toBe('validation.failed')
    const issues =
      (refused.body.error as { context?: { issues?: Issue[] } } | undefined)?.context?.issues ?? []
    expect(issues.map((issue) => dotted(issue.path))).toEqual(
      expect.arrayContaining([expect.stringMatching(/(^|\.)qty$/)]),
    )

    const after = await shop.call<Cart>('GET', '/api/cart')
    expect(after.body.data!.items).toEqual(before.body.data!.items)
    expect(after.body.data!.subtotalMinor).toBe(before.body.data!.subtotalMinor)
  })

  it("AC-16: PATCH /api/customers/me with { firstName: 'A', roles: ['admin'] } answers 200, the first name is A, and the next login's token roles equal the roles column, ['customer']", async () => {
    const email = `ac16-${randomUUID()}@p1-06.test`
    const password = 'correct-horse-battery'
    await k.services.auth.register({ email, password, firstName: 'Before' })
    const shop = await primedShopper(served.baseUrl)
    const first = await login(served.baseUrl, shop.jar, { email, password })
    expect(first.status).toBe(200)
    const bearer = { authorization: `Bearer ${first.body.data!.accessToken}` }

    const patched = await shop.call<Customer>(
      'PATCH',
      '/api/customers/me',
      { firstName: 'A', roles: ['admin'] },
      { headers: bearer },
    )
    expect(patched.status, JSON.stringify(patched.body)).toBe(200)
    const profile = await shop.call<Customer>('GET', '/api/customers/me', undefined, {
      headers: bearer,
    })
    expect(profile.body.data!.firstName).toBe('A')

    const next = await login(served.baseUrl, shop.jar, { email, password })
    expect(next.status).toBe(200)
    const customerId = next.body.data!.customer.id
    const roles = tokenRoles(next.body.data!.accessToken)
    expect(roles).toEqual(await rolesColumn(raw, customerId))
    expect(roles).toEqual(['customer'])
  })

  it('AC-17: POST /api/checkout with an empty cart answers 409 checkout.cart_empty', async () => {
    const shop = await primedShopper(served.baseUrl)
    const cart = await shop.call<Cart>('GET', '/api/cart')
    expect(cart.body.data!.items).toHaveLength(0)
    const ordersBefore = await raw.count('orders')

    const res = await shop.call('POST', '/api/checkout', {
      email: `ac17-${randomUUID()}@p1-06.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error?.code).toBe('checkout.cart_empty')
    expect(await raw.count('orders')).toBe(ordersBefore)
  })
})
