import { createHash, randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Address, OrderStatus } from '@nymbalhq/types'
import { rawClients } from '../../src/db/command-store.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'

// Taking an imported order, customer or review back out of a store, through the kernel's own services on a SQLite
// file: what each removal deletes, what it publishes, and what the read models hold after the relay has delivered it.

let k: Kernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  raw = openRaw('sqlite', k.target)
})

afterAll(async () => {
  await raw?.close()
  await k?.close()
})

const address: Address = {
  firstName: 'Ada',
  lastName: 'Imported',
  addressLine1: '1 Main St',
  city: 'Leeds',
  region: 'Yorkshire',
  postalCode: 'LS1 1AA',
  country: 'GB',
}

let numbers = 0

/** An order as the WooCommerce import writes it: paid, processing, placed in the past unless `createdAt` says. */
async function importedOrder(
  customerId: string | null,
  status: OrderStatus = 'processing',
  createdAt = new Date('2024-02-01T12:00:00Z'),
) {
  numbers += 1
  return k.services.order.importOrder({
    orderId: uuidv7(),
    orderNumber: `WC-${70_000 + numbers}`,
    status,
    customerId,
    email: `buyer${numbers}@example.com`,
    billingAddress: address,
    shippingAddress: address,
    lineItems: [],
    subtotalMinor: 2500,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 2500,
    currency: 'GBP',
    metadata: { woocommerce: { orderId: numbers } },
    createdAt,
    capturedMinor: 2500,
    refundedMinor: 0,
    captureMethod: 'import',
  })
}

async function customer() {
  const { customer: c } = await k.services.auth.register({
    email: `imported-${randomUUID()}@example.com`,
    password: 'a long enough password 42',
    firstName: 'Imported',
    lastName: 'Customer',
  })
  return c
}

interface Dependents {
  shipped: boolean
  refund: boolean
  key: boolean
}

/** The dependent rows an order collects after it is imported: shipped (history and shipment), a refund, an access key. */
async function withDependents(orderId: string, d: Dependents): Promise<void> {
  if (d.shipped)
    await k.services.order.markShipped(orderId, `RM${numbers}GB`, 'Royal Mail', 'admin')
  await k.store.transaction(async (tx) => {
    if (d.refund) {
      await k.repos.orderRefund.insert(tx, {
        id: uuidv7(),
        orderId,
        amountMinor: 500,
        currency: 'GBP',
        providerRefundId: null,
        status: 'succeeded',
        reason: 'damaged',
        actor: 'admin',
        createdAt: new Date(),
      })
    }
    if (d.key) {
      await k.repos.orderAccessKey.insert(tx, {
        id: uuidv7(),
        orderId,
        keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
        purpose: 'email',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    }
  })
}

/** Rows of each kind an order owns, as a second connection reads them. */
async function rowsOf(orderId: string) {
  return {
    orders: await raw.count('orders', 'id = ?', [orderId]),
    history: await raw.count('order_history', 'order_id = ?', [orderId]),
    refunds: await raw.count('order_refunds', 'order_id = ?', [orderId]),
    keys: await raw.count('order_access_keys', 'order_id = ?', [orderId]),
    shipments: await raw.count('order_shipments', 'order_id = ?', [orderId]),
  }
}

/** The payloads of every logged event of `type`. */
async function payloadsOf(type: string): Promise<Array<Record<string, unknown>>> {
  const rows = await raw.rows<{ envelope: string }>(
    'SELECT envelope FROM events WHERE type = ? ORDER BY seq',
    [type],
  )
  return rows.map((r) => (JSON.parse(r.envelope) as { payload: Record<string, unknown> }).payload)
}

/** The order's documents: its own, and its entries under its customer. */
async function documentsOf(orderNumber: string, customerId: string | null) {
  await k.app.relay.drain()
  const own = await k.documentStore.get('orders', orderNumber)
  const underCustomer =
    customerId === null
      ? []
      : (
          await k.documentStore.query<{ orderNumber: string }>('orders-by-customer', {
            partitionKey: { field: 'partitionKey', value: `customer:${customerId}` },
          })
        ).items
          .map((d) => d.orderNumber)
          .filter((n) => n === orderNumber)
  return { own: own !== null, underCustomer: underCustomer.length }
}

const NONE = { orders: 0, history: 0, refunds: 0, keys: 0, shipments: 0 }

describe('AC-7: removeOrder', () => {
  it('AC-7: an imported order with history, a refund, an access key and a shipment is removed with all five kinds of row, one order.deleted.v1 names it, and its orders and orders-by-customer documents go; another order is untouched', async () => {
    const owner = await customer()
    const order = await importedOrder(owner.id)
    const other = await importedOrder(owner.id)
    await withDependents(order.id, { shipped: true, refund: true, key: true })
    await withDependents(other.id, { shipped: true, refund: true, key: true })
    const otherBefore = await rowsOf(other.id)
    const otherDocsBefore = await documentsOf(other.orderNumber, owner.id)
    const deletedBefore = (await payloadsOf('order.deleted.v1')).length

    const outcome = await k.services.importRemoval.removeOrder(order.id)

    expect(outcome).toBe('removed')
    expect(await rowsOf(order.id)).toEqual(NONE)
    const deleted = await payloadsOf('order.deleted.v1')
    expect(deleted.length).toBe(deletedBefore + 1)
    expect(deleted.at(-1)).toMatchObject({
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: owner.id,
    })
    expect(await documentsOf(order.orderNumber, owner.id)).toEqual({ own: false, underCustomer: 0 })
    expect(await rowsOf(other.id)).toEqual(otherBefore)
    expect(await documentsOf(other.orderNumber, owner.id)).toEqual(otherDocsBefore)
  })

  it('AC-7: for any mix of dependent rows and a guest or customer order, removeOrder leaves none of its rows, exactly one order.deleted.v1 for it, and no document for it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ shipped: fc.boolean(), refund: fc.boolean(), key: fc.boolean() }),
        fc.boolean(),
        async (dependents, guest) => {
          const owner = guest ? null : (await customer()).id
          const order = await importedOrder(owner)
          await withDependents(order.id, dependents)
          const before = await documentsOf(order.orderNumber, owner)

          const outcome = await k.services.importRemoval.removeOrder(order.id)

          expect(outcome).toBe('removed')
          expect(await rowsOf(order.id)).toEqual(NONE)
          const forIt = (await payloadsOf('order.deleted.v1')).filter(
            (p) => p['orderId'] === order.id,
          )
          expect(forIt.length).toBe(1)
          const after = await documentsOf(order.orderNumber, owner)
          expect(after).toEqual({ own: false, underCustomer: 0 })
          expect(before.own).not.toBe(after.own)
        },
      ),
      { numRuns: 20 },
    )
  })

  it('AC-7: a removal whose order delete fails leaves every dependent row and publishes nothing, as one transaction', async () => {
    const owner = await customer()
    const order = await importedOrder(owner.id)
    await withDependents(order.id, { shipped: true, refund: true, key: true })
    const before = await rowsOf(order.id)
    const deletedBefore = (await payloadsOf('order.deleted.v1')).length
    const clients = rawClients(k.store)
    if (clients.kind !== 'sqlite') throw new Error('a SQLite kernel')
    const trigger = `refuse_delete_${order.id.replace(/-/g, '_')}`
    clients.raw.exec(
      `CREATE TEMP TRIGGER ${trigger} BEFORE DELETE ON main.orders WHEN OLD.id = '${order.id}' ` +
        `BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`,
    )
    let outcome: unknown
    try {
      outcome = await k.services.importRemoval.removeOrder(order.id).catch((e: unknown) => e)
    } finally {
      clients.raw.exec(`DROP TRIGGER IF EXISTS temp.${trigger}`)
    }

    expect(String(outcome)).toMatch(/refused by the test/)
    expect(await rowsOf(order.id)).toEqual(before)
    expect((await payloadsOf('order.deleted.v1')).length).toBe(deletedBefore)
  })
})

describe('AC-7: removeCustomer and removeReview', () => {
  it('AC-7: removeCustomer deletes the customer and its refresh tokens, publishes customer.deleted.v1 for it, and its profile document goes', async () => {
    const c = await customer()
    await k.app.relay.drain()
    const profileBefore = await k.documentStore.get('customer-profiles', c.id)
    const tokensBefore = await raw.count('refresh_tokens', 'customer_id = ?', [c.id])

    const outcome = await k.services.importRemoval.removeCustomer(c.id)
    await k.app.relay.drain()

    expect(outcome).toBe('removed')
    expect({
      customers: await raw.count('customers', 'id = ?', [c.id]),
      tokens: await raw.count('refresh_tokens', 'customer_id = ?', [c.id]),
    }).toEqual({ customers: 0, tokens: 0 })
    expect(tokensBefore).toBeGreaterThan(0)
    expect(
      (await payloadsOf('customer.deleted.v1')).filter((p) => p['customerId'] === c.id).length,
    ).toBe(1)
    expect({
      before: profileBefore !== null,
      after: (await k.documentStore.get('customer-profiles', c.id)) !== null,
    }).toEqual({ before: true, after: false })
  })

  it('AC-7: removeReview deletes the review row and leaves the product’s other reviews', async () => {
    const product = await k.services.product.create({
      slug: `reviewed-${randomUUID()}`,
      name: 'Reviewed',
      description: '',
      status: 'active',
      variants: [
        {
          sku: `R-${randomUUID()}`,
          name: 'Default',
          priceMinor: 1000,
          stock: 1,
          lowStockThreshold: 0,
          options: [],
        },
      ],
    })
    const submit = (body: string) =>
      k.app.adapters.reviews.submitReview({
        productId: product.id,
        customerId: null,
        author: null,
        orderId: null,
        rating: 4,
        title: '',
        body,
      })
    const gone = await submit('imported')
    const kept = await submit('the store’s own')
    const before = await raw.count('reviews', 'product_id = ?', [product.id])

    const outcome = await k.services.importRemoval.removeReview(gone.review.id)

    expect(outcome).toBe('removed')
    expect(await raw.count('reviews', 'product_id = ?', [product.id])).toBe(before - 1)
    expect({
      gone: await raw.count('reviews', 'id = ?', [gone.review.id]),
      kept: await raw.count('reviews', 'id = ?', [kept.review.id]),
    }).toEqual({ gone: 0, kept: 1 })
  })

  it('AC-7: an id no order, customer or review has resolves absent for each removal and publishes nothing', async () => {
    const eventsBefore = await raw.count('events')

    const outcomes = [
      await k.services.importRemoval.removeOrder(uuidv7()),
      await k.services.importRemoval.removeCustomer(uuidv7()),
      await k.services.importRemoval.removeReview(uuidv7()),
    ]

    expect(outcomes).toEqual(['absent', 'absent', 'absent'])
    expect(await raw.count('events')).toBe(eventsBefore)
  })
})

// The rollback refuses a store that has activity of its own since the import began: an order it did not import, any
// later row on an order it did, or a review it did not import. `activitySince` is the count the refusal names. The
// kernel is shared by the file, so each case measures from a baseline read at its own `since`.
describe('AC-6: activitySince', () => {
  async function reviewedProduct() {
    const product = await k.services.product.create({
      slug: `activity-${randomUUID()}`,
      name: 'Activity',
      description: '',
      status: 'active',
      variants: [
        {
          sku: `A-${randomUUID()}`,
          name: 'Default',
          priceMinor: 1000,
          stock: 1,
          lowStockThreshold: 0,
          options: [],
        },
      ],
    })
    return async (body: string) =>
      (
        await k.app.adapters.reviews.submitReview({
          productId: product.id,
          customerId: null,
          author: null,
          orderId: null,
          rating: 5,
          title: '',
          body,
        })
      ).review.id
  }

  // Defects: a held order's later status change, shipment, refund or key goes uncounted (the rollback deletes what an
  // admin did); a held order or review counts as live (every rollback refuses); an order shipped (history and
  // shipment) counts twice; an order placed before the import, or its later rows, count as the import's.
  it('AC-6: a quiet import counts nothing; each held order with later activity, each order not imported and each review not imported counts once', async () => {
    const since = new Date().toISOString()
    const [quiet, keyed, refunded, shipped, cancelled, parcelled] = [
      await importedOrder(null),
      await importedOrder(null),
      await importedOrder(null),
      await importedOrder(null),
      await importedOrder(null),
      await importedOrder(null),
    ]
    // Placed in WooCommerce today, so its row is dated after `since` like the store's own orders.
    const recent = await importedOrder(null, 'processing', new Date())
    const review = await reviewedProduct()
    const heldReviews = [await review('imported one'), await review('imported two')]
    const held = {
      orders: [quiet.id, keyed.id, refunded.id, shipped.id, cancelled.id, parcelled.id, recent.id],
      reviews: heldReviews,
    }
    const activity = () => k.services.importRemoval.activitySince(since, held)
    const quietStore = await activity()

    expect(
      await k.services.importRemoval.activitySince(since, { orders: [], reviews: [] }),
    ).toEqual({
      orders: quietStore.orders + 1,
      reviews: quietStore.reviews + heldReviews.length,
    })

    // The store's own order from before the import began: neither it nor its later shipment is the import's.
    const older = await importedOrder(null)
    await withDependents(older.id, { shipped: true, refund: true, key: true })
    const afterOlder = await activity()
    await withDependents(keyed.id, { shipped: false, refund: false, key: true })
    const afterKey = await activity()
    await withDependents(refunded.id, { shipped: false, refund: true, key: false })
    const afterRefund = await activity()
    await withDependents(shipped.id, { shipped: true, refund: false, key: false })
    const afterShip = await activity()
    await k.services.order.updateStatus(cancelled.id, 'cancelled', 'admin')
    const afterCancel = await activity()
    // A shipment row with no history row beside it, so each kind of row is counted on its own. No service writes one
    // alone, so it goes in outside the store's transactions, as the trigger case above does.
    const clients = rawClients(k.store)
    if (clients.kind !== 'sqlite') throw new Error('a SQLite kernel')
    clients.raw
      .prepare(
        'INSERT INTO order_shipments (order_id, carrier, tracking_number, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(parcelled.id, 'Royal Mail', `RM${numbers}GB`, new Date().toISOString())
    const afterParcel = await activity()
    await importedOrder(null, 'processing', new Date()) // the store's own, placed since
    const afterOwnOrder = await activity()
    await review('the store’s own')
    const afterOwnReview = await activity()

    expect([
      afterOlder,
      afterKey,
      afterRefund,
      afterShip,
      afterCancel,
      afterParcel,
      afterOwnOrder,
      afterOwnReview,
    ]).toEqual([
      { orders: quietStore.orders, reviews: quietStore.reviews },
      { orders: quietStore.orders + 1, reviews: quietStore.reviews },
      { orders: quietStore.orders + 2, reviews: quietStore.reviews },
      { orders: quietStore.orders + 3, reviews: quietStore.reviews },
      { orders: quietStore.orders + 4, reviews: quietStore.reviews },
      { orders: quietStore.orders + 5, reviews: quietStore.reviews },
      { orders: quietStore.orders + 6, reviews: quietStore.reviews },
      { orders: quietStore.orders + 6, reviews: quietStore.reviews + 1 },
    ])
  })

  // Defect: one kind of later row is left out of the count, or an order with several later rows counts once per row.
  it('AC-6: for any mix of later rows on held orders, the count is the held orders with at least one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ shipped: fc.boolean(), refund: fc.boolean(), key: fc.boolean() }), {
          minLength: 1,
          maxLength: 4,
        }),
        async (dependents) => {
          const since = new Date().toISOString()
          const orders: string[] = []
          for (let i = 0; i < dependents.length; i += 1) orders.push((await importedOrder(null)).id)
          const held = { orders, reviews: [] }
          const quietStore = await k.services.importRemoval.activitySince(since, held)

          for (const [i, d] of dependents.entries()) await withDependents(orders[i]!, d)
          const after = await k.services.importRemoval.activitySince(since, held)

          const touched = dependents.filter((d) => d.shipped || d.refund || d.key).length
          expect(after).toEqual({
            orders: quietStore.orders + touched,
            reviews: quietStore.reviews,
          })
        },
      ),
      { numRuns: 20 },
    )
  })
})
