import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCommandStore, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createProductRepository, type ProductInsert } from '../../src/repositories/product.js'

// Acceptance tests for P0-02 AC-8 and AC-9: the `integration-postgres` Vitest project.
// AC-9: the file refuses to load without NYMBAL_TEST_POSTGRES_URL, so a missing database fails the project; it can
// never skip or pass. The test in tests/tooling/integration-postgres.test.ts checks that from outside.
// AC-8: each run creates its own database on that server, so "runMigrations applies the migrations" is observed
// from an empty database, and the same products written to SQLite and Postgres must read back equal.

const URL_VAR = 'NYMBAL_TEST_POSTGRES_URL'
const serverUrl = process.env[URL_VAR]
if (serverUrl === undefined || serverUrl.trim() === '') {
  throw new Error(
    `${URL_VAR} is not set: the integration-postgres project needs a Postgres server ` +
      `(pnpm gate:full starts one with docker compose; e.g. ${URL_VAR}=postgres://postgres:nymbal@localhost:54329/nymbal)`,
  )
}

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url))
const JOURNAL = JSON.parse(
  readFileSync(new URL('../../migrations/postgres/meta/_journal.json', import.meta.url), 'utf8'),
) as {
  entries: unknown[]
}

const dbName = `nymbal_test_${process.pid}_${Date.now()}`
let admin: pg.Pool
let store: CommandStore
let sqlite: CommandStore

function postgresStore(database: string): CommandStore {
  const url = new URL(serverUrl!)
  url.pathname = `/${database}`
  return createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'postgres' }, store: { name: 'test', currency: 'GBP' } },
    { postgresUrl: url.toString() },
  )
}

async function query<T>(sql: string): Promise<T[]> {
  if (store.kind !== 'postgres') throw new Error('expected a postgres store')
  const result = await store.pool.query(sql)
  return result.rows as T[]
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: serverUrl })
  await admin.query(`CREATE DATABASE ${dbName}`)
  store = postgresStore(dbName)
  sqlite = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(sqlite, { migrationsRoot: MIGRATIONS })
})

afterAll(async () => {
  await store?.close()
  await sqlite?.close()
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  }
})

describe('AC-8: the command store on Postgres', () => {
  it('AC-8: createCommandStore connects to the Postgres server', async () => {
    expect(store.kind).toBe('postgres')
    const [row] = await query<{ db: string; one: number }>(
      'SELECT current_database() AS db, 1 AS one',
    )
    expect(row).toEqual({ db: dbName, one: 1 })
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
        await onPostgres.insert(input)
        await onSqlite.insert(input)

        const fromPostgres = await onPostgres.findById(input.id)
        const fromSqlite = await onSqlite.findById(input.id)
        expect(fromPostgres).toEqual({
          ...input,
          createdAt: input.createdAt.toISOString(),
          updatedAt: input.updatedAt.toISOString(),
        })
        expect(fromPostgres).toEqual(fromSqlite)
        expect(await onPostgres.findBySlug(input.slug)).toEqual(fromPostgres)
      }),
      { numRuns: 25 },
    )
  })
})
