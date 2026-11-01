import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Seeded } from '../support/kernel.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'
import {
  bearer,
  freshShop,
  lapsedToken,
  registeredCustomer,
  type Customer,
} from '../support/recently-viewed.js'

// AC-5 on a served kernel (SQLite): POST /api/checkout with a bearer the auth middleware cannot verify (past its 15
// minutes, or signed with another secret) is refused with 401 auth.token_invalid, so the client refreshes and retries
// as the customer; it never becomes a guest order. With no authorization header a guest still checks out.

interface Placed {
  orderId: string
  orderNumber: string
  orderStatus: string
  orderKey?: string
}

describe('AC-5: POST /api/checkout and a bearer that does not verify (sqlite)', () => {
  let served: ServedKernel
  let raw: RawReader
  let seeded: Seeded
  let customer: Customer
  let intents = 0

  beforeAll(async () => {
    const kernel = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(kernel)
    raw = openRaw(kernel.dialect, kernel.target)
    seeded = await seedVariant(kernel, 20)
    customer = await registeredCustomer(kernel)
    const payments = kernel.app.adapters.payments
    const create = payments.createPaymentIntent
    payments.createPaymentIntent = async (...args) => {
      intents += 1
      return create.apply(payments, args)
    }
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  /** A shopper of its own with one unit in its cart. */
  async function shopWithCart() {
    const shop = await freshShop(served.baseUrl)
    const added = await shop.call('POST', '/api/cart/items', {
      variantId: seeded.variantId,
      qty: 1,
    })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    return shop
  }

  const checkoutBody = () => ({
    email: customer.email,
    billingAddress: address,
    shippingAddress: address,
  })

  /** What a checkout can leave behind, as a second connection reads it. */
  async function traces() {
    return {
      orders: await raw.count('orders'),
      reservations: await raw.count('inventory_reservations'),
      intents,
      stock: await stockOf(raw, seeded.variantId),
    }
  }

  for (const how of ['expired', 'foreign'] as const) {
    it(`AC-5: a bearer that is ${how === 'expired' ? 'past its expiry' : 'signed with another secret'} answers 401 auth.token_invalid and leaves no order, reservation or payment intent`, async () => {
      const shop = await shopWithCart()
      const before = await traces()

      const res = await shop.call<Placed>('POST', '/api/checkout', checkoutBody(), {
        headers: bearer(await lapsedToken(served.kernel, customer, how)),
      })

      expect([res.status, res.body.error?.code], JSON.stringify(res.body)).toEqual([
        401,
        'auth.token_invalid',
      ])
      expect(await traces(), 'orders, reservations, intents and stock').toEqual(before)
      expect(
        await raw.count('orders', 'email = ?', [customer.email]),
        'orders with the customer’s email',
      ).toBe(0)
    })
  }

  it('AC-5: with no authorization header the same checkout places a guest order, with its key, as before', async () => {
    const shop = await shopWithCart()
    const before = await traces()
    const email = `guest-${randomUUID()}@lapsed.test`

    const res = await shop.call<Placed>('POST', '/api/checkout', { ...checkoutBody(), email })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const placed = res.body.data!
    expect(typeof placed.orderKey, 'a guest order carries its key').toBe('string')
    const row = await raw.one<{ customer_id: string | null; email: string }>(
      'SELECT customer_id, email FROM orders WHERE id = ?',
      [placed.orderId],
    )
    expect(row).toEqual({ customer_id: null, email })
    const after = await traces()
    expect(after.orders).toBe(before.orders + 1)
    expect(after.intents).toBe(before.intents + 1)
    expect(after.stock).toBe(before.stock - 1)
  })
})
