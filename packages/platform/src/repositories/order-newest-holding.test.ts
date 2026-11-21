import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import type { OrderLineItem, OrderStatus } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'

// `newestHolding` decides whether a review is from a verified buyer: the customer's newest order in the given
// statuses whose lines hold the product. It walks the customer's orders newest first a page at a time, so the answer
// must not depend on where the page boundaries fall.

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  return { store, repos }
}
type Env = Awaited<ReturnType<typeof setup>>

const STATUSES: readonly OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const PAGE = 50

function line(productId: string): OrderLineItem {
  return {
    variantId: uuidv7(),
    productId,
    productName: 'Product',
    variantName: 'Default',
    sku: `SKU-${productId.slice(-6)}`,
    qty: 1,
    unitPriceMinor: 1000,
    lineSubtotalMinor: 1000,
    lineTaxMinor: 0,
    lineTotalMinor: 1000,
    imageUrl: '',
  }
}

interface Placed {
  id: string
  customerId: string
  status: OrderStatus
  /** Seconds after T0; equal values put orders at the same instant, so the id breaks the tie. */
  at: number
  productIds: string[]
}

let sequence = 0
async function place(env: Env, orders: readonly Placed[]): Promise<void> {
  await env.store.transaction(async (tx) => {
    for (const o of orders) {
      sequence += 1
      const createdAt = new Date(T0 + o.at * 1000)
      await env.repos.order.insert(tx, {
        id: o.id,
        orderNumber: `OR-${sequence}`,
        sequence,
        customerId: o.customerId,
        status: o.status,
        email: 'o@example.com',
        billingAddress: {} as never,
        shippingAddress: {} as never,
        lineItems: o.productIds.map(line),
        subtotalMinor: 1000,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor: 1000,
        currency: 'GBP',
        createdAt,
        updatedAt: createdAt,
      })
    }
  })
}

const newestHolding = (
  env: Env,
  customerId: string,
  productId: string,
  statuses: readonly OrderStatus[],
) => env.store.read((tx) => env.repos.order.newestHolding(tx, customerId, productId, statuses))

/** The model: the newest (by time, then id) of the customer's orders in `statuses` with a line for the product. */
function expectedNewest(
  orders: readonly Placed[],
  customerId: string,
  productId: string,
  statuses: readonly OrderStatus[],
): string | null {
  const qualifying = orders
    .filter((o) => o.customerId === customerId && statuses.includes(o.status))
    .filter((o) => o.productIds.includes(productId))
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
  return qualifying[0]?.id ?? null
}

describe('OrderRepository.newestHolding', () => {
  // Defect: another customer's order, an order in a status outside the list, or an order without the product answers
  // (a review shows as verified when it is not), or an older order wins over the newest (wrong time or id order), or
  // a customer with no qualifying order gets one rather than null.
  it("answers the customer's newest order in the statuses that holds the product, and null when none does", async () => {
    const env = await setup()
    const orderArb = fc.record({
      mine: fc.boolean(),
      status: fc.constantFrom(...STATUSES),
      // The product on its own, beside another product, or absent.
      lines: fc.constantFrom('product', 'both', 'other', 'none'),
      at: fc.integer({ min: 0, max: 4 }),
    })
    await fc.assert(
      fc.asyncProperty(
        fc.array(orderArb, { maxLength: 16 }),
        fc.subarray([...STATUSES]),
        async (drawn, statuses) => {
          const [customer, stranger, product, other] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()]
          const orders: Placed[] = drawn.map((d) => ({
            id: uuidv7(),
            customerId: d.mine ? customer : stranger,
            status: d.status,
            at: d.at,
            productIds:
              d.lines === 'product'
                ? [product]
                : d.lines === 'both'
                  ? [other, product]
                  : d.lines === 'other'
                    ? [other]
                    : [],
          }))
          await place(env, orders)

          const found = await newestHolding(env, customer, product, statuses)
          expect(found?.id ?? null).toBe(expectedNewest(orders, customer, product, statuses))
          // No statuses to look in is no order, whatever the customer bought.
          expect(await newestHolding(env, customer, product, [])).toBeNull()
        },
      ),
      { numRuns: 60 },
    )
    await env.store.close()
  }, 30_000)

  // Defect: the walk stops after the first page (a full page read as the last one), or its keyset loses or repeats
  // rows at the boundary when the boundary orders share an instant, so a buyer whose purchase sits behind 50 newer
  // orders reads as not having bought the product.
  it('finds a holding order behind a full first page of newer orders, at distinct or equal instants', async () => {
    const env = await setup()
    const statuses: readonly OrderStatus[] = ['confirmed', 'delivered']
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: PAGE - 1, max: 2 * PAGE + 30 }),
        fc.boolean(),
        async (newer, sameInstant) => {
          const [customer, stranger, product, other] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()]
          // Ascending ids: at one instant the oldest order is the one with the smallest id.
          const ids = Array.from({ length: newer + 1 }, () => uuidv7()).sort()
          const holder: Placed = {
            id: ids[0]!,
            customerId: customer,
            status: 'delivered',
            at: 0,
            productIds: [other, product],
          }
          const orders: Placed[] = [
            holder,
            ...ids.slice(1).map((id, i) => ({
              id,
              customerId: customer,
              status: i % 2 === 0 ? ('confirmed' as const) : ('delivered' as const),
              at: sameInstant ? 0 : i + 1,
              productIds: [other],
            })),
            // Newer orders holding the product that must not answer: outside the statuses, or someone else's.
            {
              id: uuidv7(),
              customerId: customer,
              status: 'cancelled',
              at: newer + 5,
              productIds: [product],
            },
            {
              id: uuidv7(),
              customerId: stranger,
              status: 'delivered',
              at: newer + 5,
              productIds: [product],
            },
          ]
          await place(env, orders)

          const found = await newestHolding(env, customer, product, statuses)
          expect(found?.id).toBe(expectedNewest(orders, customer, product, statuses))
          expect(found?.id).toBe(holder.id)
          // A product the customer never bought is null however many pages there are.
          expect(await newestHolding(env, customer, uuidv7(), statuses)).toBeNull()
        },
      ),
      {
        numRuns: 12,
        examples: [
          [PAGE, true],
          [PAGE, false],
          [2 * PAGE, true],
        ],
      },
    )
    await env.store.close()
  }, 30_000)
})
