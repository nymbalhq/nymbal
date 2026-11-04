import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { OrderHistoryInsert } from './order-history.js'

// An order's history goes with the order and touches no other order's; the entries written since an instant name
// their order once per entry, the instant included.

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
  return { store, repo: repos.orderHistory }
}
type Env = Awaited<ReturnType<typeof setup>>

function entry(orderId: string, timestamp: Date): OrderHistoryInsert {
  return {
    id: uuidv7(),
    orderId,
    fromStatus: 'confirmed',
    toStatus: 'processing',
    actor: 'admin:1',
    timestamp,
  }
}

const append = (env: Env, e: OrderHistoryInsert) =>
  env.store.transaction((tx) => env.repo.append(tx, e))
const listOf = (env: Env, orderId: string) =>
  env.store.read((tx) => env.repo.listByOrder(tx, orderId))

describe('OrderHistoryRepository: removal and entries since a time', () => {
  // Defect: the delete loses its order condition (one imported order's rollback takes every order's history with
  // it) or deletes nothing (the removed order leaves history behind).
  it('deleteByOrder removes the history of that order and leaves every other order’s as it was', async () => {
    const env = await setup()
    const [gone, kept] = [uuidv7(), uuidv7()]
    const base = Date.UTC(2026, 9, 1, 10, 0, 0)
    for (const at of [0, 1, 2]) await append(env, entry(gone, new Date(base + at * 1000)))
    for (const at of [0, 3]) await append(env, entry(kept, new Date(base + at * 1000)))
    const keptBefore = await listOf(env, kept)

    await env.store.transaction((tx) => env.repo.deleteByOrder(tx, gone))

    expect(await listOf(env, gone)).toEqual([])
    expect(await listOf(env, kept)).toEqual(keptBefore)
    await env.store.close()
  })

  // Defect: the bound is strict or reversed (an entry written the instant the import ran, or one before it, is
  // counted the wrong way), the filter is dropped, or ids are collapsed so an order moved twice counts once.
  it('orderIdsSince answers the order of each entry written at or after the time, none before', async () => {
    const env = await setup()
    const base = Date.UTC(2026, 9, 1, 10, 0, 0)
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ which: fc.integer({ min: 0, max: 2 }), at: fc.integer({ min: -3, max: 3 }) }),
          { maxLength: 6 },
        ),
        fc.integer({ min: -3, max: 3 }),
        async (specs, sinceAt) => {
          // Fresh order ids each run, so earlier runs' rows are told apart and a counterexample replays alone.
          const orders = [uuidv7(), uuidv7(), uuidv7()]
          for (const s of specs)
            await append(env, entry(orders[s.which]!, new Date(base + s.at * 1000)))
          const since = new Date(base + sinceAt * 1000)
          const got = await env.store.read((tx) => env.repo.orderIdsSince(tx, since))
          const expected = specs.filter((s) => s.at >= sinceAt).map((s) => orders[s.which]!)
          expect(got.filter((id) => orders.includes(id)).sort()).toEqual(expected.sort())
        },
      ),
      { numRuns: 20 },
    )
    await env.store.close()
  })
})
