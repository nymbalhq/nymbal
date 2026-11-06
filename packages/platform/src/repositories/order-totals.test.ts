import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { CustomerOrderTotals } from './order.js'

// A customer's order totals on SQLite: every order counted, the money kept is Σ (captured − refunded), the orders
// that captured money counted apart, and the first and last order by createdAt; another customer's orders and orders
// with no customer stay out.

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

interface Planned {
  capturedMinor: number
  refundedMinor: number
  createdAt: Date
}

const BASE = Date.parse('2026-01-01T00:00:00.000Z')

let sequence = 0
async function insertOrder(env: Env, customerId: string | null, plan: Planned): Promise<void> {
  const id = uuidv7()
  sequence += 1
  await env.store.transaction((tx) =>
    env.repos.order.insert(tx, {
      id,
      orderNumber: `OT-${sequence}-${id.slice(-6)}`,
      sequence,
      customerId,
      status: plan.capturedMinor === 0 ? 'pending' : 'confirmed',
      email: 'o@example.com',
      billingAddress: {} as never,
      shippingAddress: {} as never,
      lineItems: [],
      subtotalMinor: 9000,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 9000,
      currency: 'GBP',
      notes: '',
      metadata: {},
      paymentIntentId: null,
      ...(plan.capturedMinor === 0
        ? {}
        : {
            capture: {
              amountMinor: plan.capturedMinor,
              method: 'manual' as const,
              at: plan.createdAt,
              refundedMinor: plan.refundedMinor,
            },
          }),
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
    }),
  )
}

const totalsOf = (env: Env, customerId: string): Promise<CustomerOrderTotals> =>
  env.store.read((tx) => env.repos.order.totalsByCustomer(tx, customerId))

/** An unpaid order, or a paid one with a refund of none, part or all of what it captured. */
const plannedOrder: fc.Arbitrary<Planned> = fc
  .record({
    capturedMinor: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 50_000 })),
    refundShare: fc.oneof(
      fc.constant(0),
      fc.constant(1),
      fc.double({ min: 0, max: 1, noNaN: true }),
    ),
    minutes: fc.integer({ min: 0, max: 60 * 24 * 365 }),
  })
  .map(({ capturedMinor, refundShare, minutes }) => ({
    capturedMinor,
    refundedMinor: Math.floor(capturedMinor * refundShare),
    createdAt: new Date(BASE + minutes * 60_000),
  }))

describe('OrderRepository.totalsByCustomer', () => {
  let env: Env

  beforeAll(async () => {
    env = await setup()
  })

  afterAll(async () => {
    await env.store.close()
  })

  it('a customer with no orders: nothing counted, no first or last order', async () => {
    await insertOrder(env, uuidv7(), {
      capturedMinor: 1200,
      refundedMinor: 0,
      createdAt: new Date(BASE),
    })
    expect(await totalsOf(env, uuidv7())).toEqual({
      orderCount: 0,
      keptMinor: 0,
      capturedCount: 0,
      firstAt: null,
      lastAt: null,
    })
  })

  it('an unpaid, a paid, a partly refunded and a fully refunded order: every order counted, the money kept, the three that captured money, and the first and last createdAt', async () => {
    const customerId = uuidv7()
    const at = (day: number) => new Date(BASE + day * 86_400_000)
    await insertOrder(env, customerId, { capturedMinor: 0, refundedMinor: 0, createdAt: at(3) })
    await insertOrder(env, customerId, { capturedMinor: 2500, refundedMinor: 0, createdAt: at(1) })
    await insertOrder(env, customerId, {
      capturedMinor: 4000,
      refundedMinor: 1500,
      createdAt: at(7),
    })
    await insertOrder(env, customerId, {
      capturedMinor: 3000,
      refundedMinor: 3000,
      createdAt: at(5),
    })
    await insertOrder(env, null, { capturedMinor: 9999, refundedMinor: 0, createdAt: at(0) })

    expect(await totalsOf(env, customerId)).toEqual({
      orderCount: 4,
      keptMinor: 2500 + (4000 - 1500) + 0,
      capturedCount: 3,
      firstAt: at(1).toISOString(),
      lastAt: at(7).toISOString(),
    })
  })

  it('property: over generated orders for one customer beside another customer’s, the totals are the count, Σ (captured − refunded), the orders with captured > 0, and the min and max createdAt of that customer’s orders alone', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(plannedOrder, { minLength: 1, maxLength: 8 }),
        fc.array(plannedOrder, { maxLength: 3 }),
        async (mine, theirs) => {
          const customerId = uuidv7()
          const otherId = uuidv7()
          for (const plan of mine) await insertOrder(env, customerId, plan)
          for (const plan of theirs) await insertOrder(env, otherId, plan)

          const times = mine.map((p) => p.createdAt.getTime())
          expect(await totalsOf(env, customerId)).toEqual({
            orderCount: mine.length,
            keptMinor: mine.reduce((sum, p) => sum + p.capturedMinor - p.refundedMinor, 0),
            capturedCount: mine.filter((p) => p.capturedMinor > 0).length,
            firstAt: new Date(Math.min(...times)).toISOString(),
            lastAt: new Date(Math.max(...times)).toISOString(),
          })
        },
      ),
      { numRuns: 40 },
    )
  })
})
