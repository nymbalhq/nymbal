import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCommandStore, rawClients, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createProductRepository, type ProductInsert } from '../../src/repositories/product.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'

// Acceptance tests for P0-02 AC-8 and AC-9: the `integration-postgres` Vitest project.
// AC-9: the file refuses to load without NYMBAL_TEST_POSTGRES_URL, so a missing database fails the project; it can
// never skip or pass. The test in tests/tooling/integration-postgres.test.ts checks that from outside.
// AC-8: each run creates its own database on that server, so "runMigrations applies the migrations" is observed
// from an empty database, and the same products written to SQLite and Postgres must read back equal.

const serverUrl = postgresServerUrl()

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url))
const JOURNAL = JSON.parse(
  readFileSync(new URL('../../migrations/postgres/meta/_journal.json', import.meta.url), 'utf8'),
) as {
  entries: unknown[]
}

let db: TestDatabase | undefined
let store: CommandStore
let sqlite: CommandStore
// Every Postgres store this file opens. The database is dropped WITH (FORCE), which terminates any connection still
// open to it; an idle pooled client terminated that way emits an error nobody handles, so each store is closed first.
const opened: CommandStore[] = []

function postgresStore(url: string): CommandStore {
  const opening = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'postgres' }, store: { name: 'test', currency: 'GBP' } },
    { postgresUrl: url },
  )
  opened.push(opening)
  return opening
}

async function query<T>(sql: string): Promise<T[]> {
  const clients = rawClients(store)
  if (clients.kind !== 'postgres') throw new Error('expected a postgres store')
  const result = await clients.pool.query(sql)
  return result.rows as T[]
}

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'command_store')
  store = postgresStore(db.url)
  sqlite = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(sqlite, { migrationsRoot: MIGRATIONS })
})

afterAll(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()))
  await sqlite?.close()
  // close() resolves before each pooled client's socket has gone; drop() waits until the server has let them go.
  await db?.drop()
})

describe('AC-8: the command store on Postgres', () => {
  it('AC-8: createCommandStore connects to the Postgres server', async () => {
    expect(store.kind).toBe('postgres')
    const [row] = await query<{ db: string; one: number }>(
      'SELECT current_database() AS db, 1 AS one',
    )
    expect(row).toEqual({ db: db!.name, one: 1 })
  })

  it('AC-8: runMigrations applies every Postgres migration to an empty database and creates products', async () => {
    const [before] = await query<{ t: string | null }>(
      "SELECT to_regclass('public.products')::text AS t",
    )
    expect(before!.t).toBeNull()

    await runMigrations(store, { migrationsRoot: MIGRATIONS })

    const [after] = await query<{ t: string | null }>(
      "SELECT to_regclass('public.products')::text AS t",
    )
    expect(after!.t).toBe('products')
    const [applied] = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations',
    )
    expect(Number(applied!.n)).toBe(JOURNAL.entries.length)
  })

  const text = fc.string({ maxLength: 40 })
  const productArb = fc.record({
    name: fc.string({ minLength: 1, maxLength: 40 }),
    description: text,
    shortDescription: text,
    status: fc.constantFrom('draft' as const, 'active' as const, 'archived' as const),
    type: fc.constantFrom('simple' as const, 'variable' as const),
    seoTitle: text,
    seoDescription: text,
    media: fc.array(fc.record({ url: fc.webUrl(), altText: text, position: fc.nat(20) }), {
      maxLength: 3,
    }),
    metadata: fc.dictionary(
      fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,8}$/),
      fc.oneof(fc.integer(), text, fc.boolean()),
      { maxKeys: 4, noNullPrototype: true },
    ),
    createdAt: fc.date({
      min: new Date('2000-01-01T00:00:00Z'),
      max: new Date('2099-12-31T00:00:00Z'),
      noInvalidDate: true,
    }),
    updatedAt: fc.date({
      min: new Date('2000-01-01T00:00:00Z'),
      max: new Date('2099-12-31T00:00:00Z'),
      noInvalidDate: true,
    }),
  })

  it('AC-8: property: a product written through createProductRepository reads back equal, on Postgres as on SQLite', async () => {
    await runMigrations(store, { migrationsRoot: MIGRATIONS })
    const onPostgres = createProductRepository(store)
    const onSqlite = createProductRepository(sqlite)
    let n = 0

    await fc.assert(
      fc.asyncProperty(productArb, async (fields) => {
        n += 1
        const input: ProductInsert = { ...fields, id: `prod_${n}`, slug: `slug-${n}` }
        await store.transaction((tx) => onPostgres.insert(tx, input))
        await sqlite.transaction((tx) => onSqlite.insert(tx, input))

        const fromPostgres = await store.read((tx) => onPostgres.findById(tx, input.id))
        const fromSqlite = await sqlite.read((tx) => onSqlite.findById(tx, input.id))
        expect(fromPostgres).toEqual({
          ...input,
          createdAt: input.createdAt.toISOString(),
          updatedAt: input.updatedAt.toISOString(),
        })
        expect(fromPostgres).toEqual(fromSqlite)
        expect(await store.read((tx) => onPostgres.findBySlug(tx, input.slug))).toEqual(
          fromPostgres,
        )
      }),
      { numRuns: 25 },
    )
  })
})
