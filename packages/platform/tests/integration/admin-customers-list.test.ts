import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, cartWith, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { primedShopper } from '../support/security.js'
import { unaudited } from '../support/write-audit.js'

// GET /api/admin/customers on SQLite: every account with the customer role, ordered or not, and never staff or a
// password hash.

interface ListedCustomer {
  id: string
  email: string
  roles: string[]
  passwordHash?: unknown
}

describe('the admin Customers list (sqlite)', () => {
  let k: Kernel
  let served: ServedKernel
  let admin: AdminClient

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    admin = await adminClient(k, served.baseUrl)
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  async function listed(query = ''): Promise<ListedCustomer[]> {
    const res = await admin.call<{ customers: ListedCustomer[] }>(
      'GET',
      `/api/admin/customers?limit=200${query}`,
    )
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.data!.customers
  }

  async function register(tag: string): Promise<{ id: string; email: string }> {
    const shop = await primedShopper(served.baseUrl)
    const email = `${tag}-${randomUUID()}@customers.test`
    const res = await shop.call<{ customer: { id: string } }>('POST', '/api/auth/register', {
      email,
      password: 'customers-correct-horse',
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return { id: res.body.data!.customer.id, email }
  }

  // Kills: customers found through orders only, so one who registered and never ordered is missing; staff listed as
  // customers once the list reads the customer table; a row from the repository sent with its password hash.
  it('AC-4: a registered customer with no order is listed, and found by part of their email; a customer with an order is listed; an admin account is not; no entry carries passwordHash', async () => {
    const browser = await register('browser')
    const buyer = await register('buyer')
    const seeded = await seedVariant(k, 2, { priceMinor: 2_400 })
    await k.services.checkout.beginCheckout({
      cartToken: await cartWith(k, seeded, 1),
      customerId: buyer.id,
      email: buyer.email,
      billingAddress: address,
      shippingAddress: address,
    })
    const staffEmail = `staff-${randomUUID()}@customers.test`
    const now = new Date()
    await unaudited(() =>
      k.store.transaction((tx) =>
        k.repos.customer.insert(tx, {
          id: randomUUID(),
          email: staffEmail,
          passwordHash: bcrypt.hashSync('staff-correct-horse', 4),
          roles: ['admin'],
          requiresPasswordReset: false,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    )

    const all = await listed()
    const ids = all.map((c) => c.id)
    expect(ids, 'the registered customer with no order').toContain(browser.id)
    expect(ids, 'the customer with an order').toContain(buyer.id)
    expect(
      all.map((c) => c.email),
      'an admin account',
    ).not.toContain(staffEmail)
    const customers = all.filter((c) => c.roles.includes('customer'))
    expect(customers.length, `entries without the customer role in ${all.length}`).toBe(all.length)
    const withHash = all.filter((c) => 'passwordHash' in c).map((c) => c.email)
    expect(
      all.length - withHash.length,
      `entries carrying passwordHash: ${withHash.join(', ')}`,
    ).toBe(all.length)

    // Part of the local part, in another case: the search is a substring match on the email.
    const part = browser.email.slice(0, browser.email.indexOf('@')).slice(-12).toUpperCase()
    const found = await listed(`&q=${encodeURIComponent(part)}`)
    expect(
      found.map((c) => c.id),
      `GET /api/admin/customers?q=${part}`,
    ).toEqual([browser.id])
    // The search narrows the same list: no customer it finds is missing from the list unfiltered.
    expect(found, 'the search answer vs the unfiltered list').toEqual(
      all.filter((c) => c.email.toLowerCase().includes(part.toLowerCase())),
    )
  })
})
