import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { OrderAccessKeyInsert } from './order-access-key.js'

// An order's access keys go with the order and no other order's key stops working; the keys minted since an instant
// name their order once per key, the instant included.

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
  return { store, repo: repos.orderAccessKey }
}
type Env = Awaited<ReturnType<typeof setup>>

const NOW = new Date(Date.UTC(2026, 9, 1, 10, 0, 0))

function key(orderId: string, createdAt: Date): OrderAccessKeyInsert {
  return {
    id: uuidv7(),
    orderId,
    keyHash: uuidv7(),
    purpose: 'checkout',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 86_400_000),
  }
}

const insert = (env: Env, k: OrderAccessKeyInsert) =>
  env.store.transaction((tx) => env.repo.insert(tx, k))
const states = (env: Env, keys: OrderAccessKeyInsert[]) =>
  env.store.read(async (tx) => {
    const out = []
    for (const k of keys) out.push(await env.repo.opens(tx, k.orderId, k.keyHash, NOW))
    return out
  })

describe('OrderAccessKeyRepository: removal and keys since a time', () => {
  // Defect: the delete loses its order condition (rolling one imported order back locks every customer out of their
  // order page) or deletes nothing (the removed order's keys stay behind).
  it('deleteByOrder removes the keys of that order and every other order’s keys open as before', async () => {
    const env = await setup()
    const [gone, kept] = [uuidv7(), uuidv7()]
    const goneKeys = [key(gone, NOW), key(gone, NOW)]
    const keptKeys = [key(kept, NOW), key(kept, NOW)]
    for (const k of [...goneKeys, ...keptKeys]) await insert(env, k)
    const keptBefore = await states(env, keptKeys)

    await env.store.transaction((tx) => env.repo.deleteByOrder(tx, gone))

    expect(await states(env, goneKeys)).toEqual(goneKeys.map(() => 'none'))
    expect(await states(env, keptKeys)).toEqual(keptBefore)
    await env.store.close()
  })

  // Defect: the bound is strict or reversed (a key minted the instant the import ran, or one before it, is counted
  // the wrong way), the filter is dropped, or ids are collapsed so an order with two keys counts once.
  it('orderIdsSince answers the order of each key minted at or after the time, none before', async () => {
    const env = await setup()
    const base = NOW.getTime()
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
            await insert(env, key(orders[s.which]!, new Date(base + s.at * 1000)))
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
