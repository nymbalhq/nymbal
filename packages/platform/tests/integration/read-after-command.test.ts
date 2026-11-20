import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Cart } from '@nymbalhq/types'
import { settlesWithin } from '../../src/tests/settles-within.js'
import { address, createKernel, seedVariant } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import {
  call,
  forgot,
  openPasswordStore,
  settled,
  type PasswordStore,
} from '../support/password-reset.js'
import type { MoneyRow } from '../support/report-rollups.js'
import { primedShopper } from '../support/security.js'
import type { ShopResponse } from '../support/shopper.js'
import { seeded } from '../support/verification.js'

// Read-your-writes while a mail is held, on SQLite over HTTP: a forgot's reset mail waits at the capturing adapter, so
// the relay's pass is held on it, and a command answered meanwhile is already in the reads that follow it: the product
// it created in GET /api/products/:slug, the order it paid in GET /api/admin/reports.

/** A request that waits on the held mail would wait for ever; this is how long each is given to answer. */
const ANSWER_BOUND_MS = 5_000

let s: PasswordStore
let admin: AdminClient

beforeAll(async () => {
  s = await openPasswordStore((opts) => createKernel({ dialect: 'sqlite', ...opts }))
  admin = await adminClient(s.k, s.base)
}, 60_000)

afterEach(async () => {
  s.mail.hold.release()
  await settled(s)
})

afterAll(async () => {
  await s?.close()
})

/** A forgot whose reset mail is now held at the adapter, the relay's pass waiting on it. */
async function mailHeld(): Promise<void> {
  const who = await seeded(s, 'held-forgot')
  s.mail.hold.hold()
  void forgot(s, who.email)
  expect(
    await settlesWithin(s.mail.hold.waiting(1), ANSWER_BOUND_MS),
    'the reset send, held at the adapter',
  ).toBe('resolved')
}

/** Today's paid orders and captured money in the store's currency, as the reports route counts them. */
async function today(currency: string): Promise<{ paidOrders: number; capturedMinor: number }> {
  const res = await admin.call<{ money: { series: MoneyRow[] } }>(
    'GET',
    '/api/admin/reports?grain=day',
  )
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const rows = res.body.data!.money.series.filter((r) => r.partial && r.currency === currency)
  return {
    paidOrders: rows.reduce((n, r) => n + r.paidOrders, 0),
    capturedMinor: rows.reduce((n, r) => n + r.capturedMinor, 0),
  }
}

describe('AC-9: a read straight after a command sees it while a mail is held', () => {
  // Defect: the product projection moved off the commit with the mail, so the storefront misses a product its create
  // answered for.
  it('AC-9: with a reset mail held, a product created through the admin API is served by GET /api/products/:slug straight after the create answers', async () => {
    await mailHeld()
    const slug = `held-read-${randomUUID()}`

    const creating = admin.call<{ id: string; slug: string }>('POST', '/api/admin/products', {
      slug,
      name: 'Read straight after',
      description: '',
      status: 'active',
      variants: [
        { sku: `HELD-${slug}`, name: 'Default', priceMinor: 1_200, stock: 3, options: [] },
      ],
    })
    expect(await settlesWithin(creating, ANSWER_BOUND_MS), 'the create, the mail held').toBe(
      'resolved',
    )
    const created = await creating
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const served = await call(s, 'GET', `/api/products/${slug}`)

    expect(served.status, served.text.slice(0, 200)).toBe(200)
    expect((served.body.data as unknown as { id: string }).id).toBe(created.body.data!.id)
  })

  // Defect: report rollups moved off the commit with the mail, so the admin's reports miss an order the shopper was
  // just told is paid.
  it('AC-9: with a reset mail held, an order paid through checkout is counted in today’s paid orders and captured money by GET /api/admin/reports straight after the payment answers', async () => {
    const product = await seedVariant(s.k, 4, { priceMinor: 2_300 })
    const shop = await primedShopper(s.base)
    expect((await shop.call<Cart>('GET', '/api/cart')).status).toBe(200)
    const added = await shop.call<Cart>('POST', '/api/cart/items', {
      variantId: product.variantId,
      qty: 2,
    })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    const before = await today(s.k.config.store.currency)
    await mailHeld()

    const paying = shop.call<{ orderId: string; totalMinor: number; currency: string }>(
      'POST',
      '/api/checkout',
      {
        email: `held-paid-${randomUUID()}@reads.test`,
        billingAddress: address,
        shippingAddress: address,
      },
    )
    expect(await settlesWithin(paying, ANSWER_BOUND_MS), 'the checkout, the mail held').toBe(
      'resolved',
    )
    const paid: ShopResponse<{ orderId: string; totalMinor: number; currency: string }> =
      await paying
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    const after = await today(paid.body.data!.currency)

    expect(after.paidOrders, 'today’s paid orders').toBe(before.paidOrders + 1)
    expect(after.capturedMinor, 'today’s captured money').toBe(
      before.capturedMinor + paid.body.data!.totalMinor,
    )
  })
})
