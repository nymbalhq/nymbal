import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'

// Removing an imported order deletes that order's row alone, and the store's own orders are found by the time they
// were placed: every order at or after an instant, the instant included.

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
  return { store, repo: repos.order }
}
type Env = Awaited<ReturnType<typeof setup>>

let sequence = 0
async function order(env: Env, createdAt = new Date()): Promise<string> {
  const id = uuidv7()
  sequence += 1
  await env.store.transaction((tx) =>
    env.repo.insert(tx, {
      id,
      orderNumber: `OR-${sequence}-${id.slice(-6)}`,
      sequence,
      customerId: null,
      status: 'confirmed',
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
      createdAt,
      updatedAt: createdAt,
    }),
  )
  return id
}

const find = (env: Env, id: string) => env.store.read((tx) => env.repo.findById(tx, id))

describe('OrderRepository: removal and orders since a time', () => {
  // Defect: the delete loses its id condition (rolling one imported order back empties the orders table) or deletes
  // nothing (the removed order stays in the store).
  it('delete removes that order and leaves every other order as it was', async () => {
    const env = await setup()
    const [gone, kept, alsoKept] = [await order(env), await order(env), await order(env)]
    const keptBefore = [await find(env, kept), await find(env, alsoKept)]

    await env.store.transaction((tx) => env.repo.delete(tx, gone))

    expect(await find(env, gone)).toBeNull()
    expect([await find(env, kept), await find(env, alsoKept)]).toEqual(keptBefore)
    await env.store.close()
  })

  // Defect: the bound is strict or reversed (an order placed the instant the import ran, or one placed before it, is
  // counted the wrong way) or the filter is dropped (every order counts as the store's own).
  it('idsCreatedSince answers every order placed at or after the time and none before', async () => {
    const env = await setup()
    const base = Date.UTC(2026, 9, 1, 10, 0, 0)
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -3, max: 3 }), { maxLength: 6 }),
        fc.integer({ min: -3, max: 3 }),
        async (offsets, sinceAt) => {
          // Fresh orders each run, so earlier runs' rows are told apart and a counterexample replays alone.
          const placed: { id: string; at: number }[] = []
          for (const at of offsets)
            placed.push({ id: await order(env, new Date(base + at * 1000)), at })
          const ids = placed.map((p) => p.id)
          const since = new Date(base + sinceAt * 1000)
          const got = await env.store.read((tx) => env.repo.idsCreatedSince(tx, since))
          const expected = placed.filter((p) => p.at >= sinceAt).map((p) => p.id)
          expect(got.filter((id) => ids.includes(id)).sort()).toEqual(expected.sort())
        },
      ),
      { numRuns: 20 },
    )
    await env.store.close()
  })
})
