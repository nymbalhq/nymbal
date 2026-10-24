import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { KeysetPage } from './page.js'

// The keyset walk the snapshot builders read a table with: every page of `listPage` on SQLite is checked against the
// slice a direct read of the whole table, sorted by id, gives.

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

const T0 = new Date('2026-01-01T00:00:00.000Z')

/** Ids from a small alphabet, so that insertion order, id order and length order all differ. */
const idArb = fc
  .array(fc.constantFrom(...'0123456789ab'), { minLength: 1, maxLength: 3 })
  .map((chars) => chars.join(''))

/** A table under test: a row with the given id goes in, and the two reads come back out. */
type Table = {
  name: string
  insert(env: Env, id: string): Promise<void>
  list(env: Env): Promise<Array<{ id: string }>>
  listPage(env: Env, page: KeysetPage): Promise<Array<{ id: string }>>
  findById(env: Env, id: string): Promise<{ id: string } | null>
}

const TABLES: Table[] = [
  {
    name: 'category',
    insert: (env, id) =>
      env.store.transaction((tx) =>
        env.repos.category.insert(tx, { id, slug: id, name: `Category ${id}`, createdAt: T0 }),
      ),
    list: (env) => env.store.read((tx) => env.repos.category.list(tx)),
    listPage: (env, page) => env.store.read((tx) => env.repos.category.listPage(tx, page)),
    findById: (env, id) => env.store.read((tx) => env.repos.category.findById(tx, id)),
  },
  {
    name: 'customer',
    insert: (env, id) =>
      env.store.transaction((tx) =>
        env.repos.customer.insert(tx, {
          id,
          email: `${id}@example.test`,
          passwordHash: 'hash',
          firstName: `First ${id}`,
          createdAt: T0,
          updatedAt: T0,
        }),
      ),
    list: (env) => env.store.read((tx) => env.repos.customer.list(tx)),
    listPage: (env, page) => env.store.read((tx) => env.repos.customer.listPage(tx, page)),
    findById: (env, id) => env.store.read((tx) => env.repos.customer.findById(tx, id)),
  },
  {
    name: 'product',
    insert: (env, id) =>
      env.store.transaction((tx) =>
        env.repos.product.insert(tx, {
          id,
          slug: id,
          name: `Product ${id}`,
          status: 'active',
          createdAt: T0,
          updatedAt: T0,
        }),
      ),
    list: (env) => env.store.read((tx) => env.repos.product.list(tx)),
    listPage: (env, page) => env.store.read((tx) => env.repos.product.listPage(tx, page)),
    findById: (env, id) => env.store.read((tx) => env.repos.product.findById(tx, id)),
  },
]

describe('listPage: a keyset walk over a table by id', () => {
  // Defect: a page is unordered, ignores `after` (so the walk repeats or skips rows), overruns `limit`, or maps a
  // row to something other than what findById gives for it.
  it('property: the pages after each other cover the table once, in id order, each the slice a sorted full read gives', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(idArb, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 5 }),
        async (ids, limit) => {
          const env = await setup()
          for (const table of TABLES) {
            for (const id of ids) await table.insert(env, id)

            const all = await table.list(env)
            expect(all.map((r) => r.id).sort()).toEqual([...ids].sort())
            const sorted = [...all].sort((a, b) => (a.id < b.id ? -1 : 1))
            const expected = Array.from({ length: Math.ceil(sorted.length / limit) }, (_, i) =>
              sorted.slice(i * limit, (i + 1) * limit),
            )

            let next: KeysetPage = { limit }
            for (const page of expected) {
              const rows = await table.listPage(env, next)
              expect(rows, `${table.name} page after ${next.after ?? 'the start'}`).toEqual(page)
              for (const row of rows) {
                expect(row, `${table.name} ${row.id}`).toEqual(await table.findById(env, row.id))
              }
              next = { after: rows.at(-1)!.id, limit }
            }
            expect(await table.listPage(env, next), `${table.name} past the end`).toEqual([])
          }
          await env.store.close()
        },
      ),
      { numRuns: 25 },
    )
  })

  it('a page bounded by `after` starts strictly after it, and an empty table has no page', async () => {
    const env = await setup()
    for (const table of TABLES) {
      expect(await table.listPage(env, { limit: 3 }), table.name).toEqual([])
      for (const id of ['b', 'a', 'ab', '9']) await table.insert(env, id)
      expect(
        (await table.listPage(env, { after: 'a', limit: 10 })).map((r) => r.id),
        table.name,
      ).toEqual(['ab', 'b'])
      expect(
        (await table.listPage(env, { after: 'a', limit: 1 })).map((r) => r.id),
        table.name,
      ).toEqual(['ab'])
    }
    await env.store.close()
  })
})
