import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'

// An order's shipment goes with the order and no other order's parcel is lost; the orders shipped since an instant
// are answered with the instant included.

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
  return { store, repo: repos.orderShipment, repos }
}
type Env = Awaited<ReturnType<typeof setup>>

let sequence = 0
async function order(env: Env): Promise<string> {
  const id = uuidv7()
  const now = new Date()
  sequence += 1
  await env.store.transaction((tx) =>
    env.repos.order.insert(tx, {
      id,
      orderNumber: `OR-${sequence}-${id.slice(-6)}`,
      sequence,
      customerId: null,
      status: 'shipped',
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
      createdAt: now,
      updatedAt: now,
    }),
  )
  return id
}

const ship = (env: Env, orderId: string, trackingNumber: string, at: Date) =>
  env.store.transaction((tx) =>
    env.repo.record(tx, { orderId, carrier: 'royal-mail', trackingNumber, at }),
  )
const shippedUnder = async (env: Env, trackingNumber: string) =>
  (await env.store.read((tx) => env.repo.ordersByTrackingNumber(tx, trackingNumber))).sort()

describe('OrderShipmentRepository: removal and shipments since a time', () => {
  // Defect: the delete loses its order condition (rolling one imported order back drops every order's parcel) or
  // deletes nothing (the removed order's shipment stays behind).
  it('deleteByOrder removes the shipment of that order and leaves every other order’s as it was', async () => {
    const env = await setup()
    const [gone, kept, other] = [await order(env), await order(env), await order(env)]
    const at = new Date(Date.UTC(2026, 9, 1, 10, 0, 0))
    // Two orders in one parcel, so the read that sees the delete also sees what it must leave.
    await ship(env, gone, 'RM-SHARED', at)
    await ship(env, kept, 'RM-SHARED', at)
    await ship(env, other, 'RM-OTHER', at)
    const otherBefore = await shippedUnder(env, 'RM-OTHER')

    await env.store.transaction((tx) => env.repo.deleteByOrder(tx, gone))

    expect(await shippedUnder(env, 'RM-SHARED')).toEqual([kept])
    expect(await shippedUnder(env, 'RM-OTHER')).toEqual(otherBefore)
    await env.store.close()
  })

  // Defect: the bound is strict or reversed (an order shipped the instant the import ran, or one before it, is
  // counted the wrong way) or the filter is dropped (every shipped order counts as activity).
  it('orderIdsSince answers every order shipped at or after the time and none before', async () => {
    const env = await setup()
    const base = Date.UTC(2026, 9, 1, 10, 0, 0)
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -3, max: 3 }), { maxLength: 6 }),
        fc.integer({ min: -3, max: 3 }),
        async (offsets, sinceAt) => {
          // Fresh orders each run, so earlier runs' rows are told apart and a counterexample replays alone.
          const shipped: { id: string; at: number }[] = []
          for (const at of offsets) {
            const id = await order(env)
            await ship(env, id, `RM-${id}`, new Date(base + at * 1000))
            shipped.push({ id, at })
          }
          const ids = shipped.map((s) => s.id)
          const since = new Date(base + sinceAt * 1000)
          const got = await env.store.read((tx) => env.repo.orderIdsSince(tx, since))
          const expected = shipped.filter((s) => s.at >= sinceAt).map((s) => s.id)
          expect(got.filter((id) => ids.includes(id)).sort()).toEqual(expected.sort())
        },
      ),
      { numRuns: 20 },
    )
    await env.store.close()
  })
})
