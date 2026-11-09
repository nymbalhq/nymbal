import fc from 'fast-check'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import { createProductRepository, type ProductInsert, type ProductRepository } from './product.js'

// A search matches literally and ignores case in any script, the order is stable across equal timestamps, and an
// insert or a patch writes what it was given and leaves the rest.

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
  return { store, repo: repos.product }
}
type Env = Awaited<ReturnType<typeof setup>>

const CREATED = new Date('2026-10-01T10:00:00.000Z')
const UPDATED = new Date('2026-10-02T10:00:00.000Z')
const at = (seconds: number) => new Date(CREATED.getTime() + seconds * 1000)

function product(id: string, over: Partial<ProductInsert> = {}): ProductInsert {
  return {
    id,
    slug: `slug-${id}`,
    name: `Name ${id}`,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  }
}

const insert = (env: Env, ...rows: ProductInsert[]) =>
  env.store.transaction(async (tx) => {
    for (const row of rows) await env.repo.insert(tx, row)
  })

const list = (env: Env, opts?: Parameters<ProductRepository['list']>[1]) =>
  env.store.read((tx) => env.repo.list(tx, opts))
const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

const FULL = {
  description: 'long',
  shortDescription: 'short',
  status: 'active',
  type: 'variable',
  seoTitle: 'title',
  seoDescription: 'meta',
  media: [{ url: 'https://cdn.test/a.jpg', alt: 'a' }],
  metadata: { colour: 'red' },
} as unknown as Partial<ProductInsert>

describe('ProductRepository on SQLite', () => {
  // Defect: the search goes back to LIKE, so a wildcard in the term matches everything, or folds ASCII only, or
  // the listed order comes from the row id alone.
  it('property: a search returns exactly the names holding the term, by creation time then id', async () => {
    const env = await setup()
    const name = fc.string({
      unit: fc.constantFrom('a', 'A', 'é', 'É', '%', '_', 'x'),
      maxLength: 5,
    })
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ name, second: fc.integer({ min: 0, max: 2 }) }), { maxLength: 8 }),
        fc.string({ unit: fc.constantFrom('a', 'É', '%', '_'), minLength: 1, maxLength: 2 }),
        async (rows, q) => {
          await env.store.transaction(async (tx) => {
            for (const row of await env.repo.list(tx)) await env.repo.delete(tx, row.id)
          })
          const inserted = rows.map((r, i) =>
            product(`p${String(rows.length - i).padStart(2, '0')}`, {
              name: r.name,
              createdAt: at(r.second),
            }),
          )
          await insert(env, ...inserted)

          const expected = inserted
            .filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))

          expect(ids(await list(env, { q }))).toEqual(ids(expected))
        },
      ),
      { numRuns: 40 },
    )
    await env.store.close()
  })

  // Defect: lower() replaces unicode_lower, which folds ASCII alone.
  it('a search folds a non-ASCII capital, in the term and in the name', async () => {
    const env = await setup()
    await insert(env, product('p1', { name: 'CAFÉ noir' }), product('p2', { name: 'tea' }))

    expect(ids(await list(env, { q: 'café' }))).toEqual(['p1'])
    await env.store.close()
  })

  // Defect: a % or _ in the term acts as a wildcard.
  it('a search for % or _ finds only the names holding that character', async () => {
    const env = await setup()
    await insert(
      env,
      product('p1', { name: '50% off' }),
      product('p2', { name: 'snake_case' }),
      product('p3', { name: 'plain' }),
    )

    expect(ids(await list(env, { q: '%' }))).toEqual(['p1'])
    expect(ids(await list(env, { q: '_' }))).toEqual(['p2'])
    await env.store.close()
  })

  // Defect: an empty term stops being "no filter", or the status filter is dropped once a term is present.
  it('an empty term lists everything and a term narrows inside the status', async () => {
    const env = await setup()
    await insert(
      env,
      product('p1', { name: 'red shirt', status: 'active' }),
      product('p2', { name: 'red hat', status: 'draft' }),
      product('p3', { name: 'blue shirt', status: 'active' }),
    )

    expect(ids(await list(env, { q: '' }))).toEqual(['p1', 'p2', 'p3'])
    expect(ids(await list(env, { q: 'red', status: 'active' }))).toEqual(['p1'])
    await env.store.close()
  })

  // Defect: equal timestamps fall back to insertion order, so a page boundary repeats or skips a row; or the created
  // time stops leading.
  it('lists by creation time, equal times by id, in pages', async () => {
    const env = await setup()
    await insert(
      env,
      product('b', { createdAt: at(1) }),
      product('a', { createdAt: at(1) }),
      product('z', { createdAt: at(0) }),
    )

    expect(ids(await list(env))).toEqual(['z', 'a', 'b'])
    expect(ids(await list(env, { limit: 1 }))).toEqual(['z'])
    expect(ids(await list(env, { limit: 1, offset: 1 }))).toEqual(['a'])
    await env.store.close()
  })

  // Defect: an unbounded list when no limit is given.
  it('lists at most 100 by default', async () => {
    const env = await setup()
    await insert(
      env,
      ...Array.from({ length: 101 }, (_, i) => product(`p${String(i).padStart(3, '0')}`)),
    )

    expect((await list(env)).length).toBe(100)
    await env.store.close()
  })

  // Defect: a default turns into another value, or a given value is replaced by the default.
  it('an insert with only the required fields reads back the defaults, and given values win', async () => {
    const env = await setup()
    await insert(env, product('bare'), product('full', FULL))

    const [bare, full] = await env.store.read(async (tx) => [
      await env.repo.findById(tx, 'bare'),
      await env.repo.findBySlug(tx, 'slug-full'),
    ])

    expect(bare).toEqual({
      id: 'bare',
      slug: 'slug-bare',
      name: 'Name bare',
      description: '',
      shortDescription: '',
      status: 'draft',
      type: 'simple',
      seoTitle: '',
      seoDescription: '',
      media: [],
      metadata: {},
      createdAt: CREATED.toISOString(),
      updatedAt: CREATED.toISOString(),
    })
    expect(full).toEqual({
      id: 'full',
      slug: 'slug-full',
      name: 'Name full',
      ...FULL,
      createdAt: CREATED.toISOString(),
      updatedAt: CREATED.toISOString(),
    })
    await env.store.close()
  })

  const PATCHES = [
    ['name', 'New'],
    ['description', 'new long'],
    ['shortDescription', 'new short'],
    ['status', 'archived'],
    ['type', 'simple'],
    ['seoTitle', 'new title'],
    ['seoDescription', 'new meta'],
    ['media', [{ url: 'https://cdn.test/b.jpg', alt: 'b' }]],
    ['metadata', { colour: 'blue' }],
  ] as const

  // Defect: a patch drops one field, or writes a field it was not given.
  it.each(PATCHES)(
    'update of %s changes that field and the timestamp only',
    async (field, value) => {
      const env = await setup()
      await insert(env, product('p1', FULL), product('p2', FULL))
      const before = await env.store.read((tx) => env.repo.findById(tx, 'p1'))

      await env.store.transaction((tx) =>
        env.repo.update(tx, 'p1', { [field]: value, updatedAt: UPDATED }),
      )

      const [after, other] = await env.store.read(async (tx) => [
        await env.repo.findById(tx, 'p1'),
        await env.repo.findById(tx, 'p2'),
      ])
      expect(after).toEqual({ ...before, [field]: value, updatedAt: UPDATED.toISOString() })
      expect(other?.updatedAt).toBe(CREATED.toISOString())
      await env.store.close()
    },
  )
})

// The unit suites run on SQLite, so drizzle's real Postgres driver stands here against a connection that records what
// it is sent and answers with `rows`. Each dialect branch is held to the statement it must send and the answer it
// must return.
interface Sent {
  text: string
  values: unknown[]
}

async function withPostgres(
  rows: unknown[][],
  run: (repo: ProductRepository, store: CommandStore) => Promise<void>,
): Promise<Sent[]> {
  const sent: Sent[] = []
  const connection = {
    query: async (statement: string | { text: string }, values?: unknown[]) => {
      if (typeof statement === 'string') return { command: statement, rows: [], rowCount: 0 }
      sent.push({ text: statement.text, values: values ?? [] })
      return { rows, rowCount: rows.length }
    },
    release: () => undefined,
  }
  const connect = vi
    .spyOn(pg.Pool.prototype, 'connect')
    .mockImplementation(async () => connection as never)
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'postgres' }, store: { name: 'test', currency: 'GBP' } },
    { postgresUrl: 'postgres://unused/none' },
  )
  try {
    await run(createProductRepository(store), store)
  } finally {
    connect.mockRestore()
    await store.close()
  }
  return sent
}

const COLUMNS =
  '"id", "slug", "name", "description", "short_description", "status", "type", "seo_title", "seo_description", "media", "metadata", "created_at", "updated_at"'
const SELECT = `select ${COLUMNS} from "products"`
const ORDER = 'order by "products"."created_at" asc, "products"."id" asc'
const NAME_HOLDS = 'strpos(lower("products"."name"), lower(cast($1 as text))) > 0'

const ROW = [
  'p1',
  'slug-1',
  'Shirt',
  'long',
  'short',
  'active',
  'simple',
  'title',
  'meta',
  [{ url: 'a.jpg' }],
  { colour: 'red' },
  CREATED.toISOString(),
  UPDATED.toISOString(),
]
const MAPPED = {
  id: 'p1',
  slug: 'slug-1',
  name: 'Shirt',
  description: 'long',
  shortDescription: 'short',
  status: 'active',
  type: 'simple',
  seoTitle: 'title',
  seoDescription: 'meta',
  media: [{ url: 'a.jpg' }],
  metadata: { colour: 'red' },
  createdAt: CREATED.toISOString(),
  updatedAt: UPDATED.toISOString(),
}

describe('ProductRepository on Postgres', () => {
  // Defect: a lookup keys on the wrong column, or the row comes through the wrong dialect.
  it('findById and findBySlug each key on their own column and map the row', async () => {
    let byId: unknown
    let bySlug: unknown

    const sent = await withPostgres([ROW], (repo, store) =>
      store.read(async (tx) => {
        byId = await repo.findById(tx, 'p1')
        bySlug = await repo.findBySlug(tx, 'slug-1')
      }),
    )

    expect(sent).toEqual([
      { text: `${SELECT} where "products"."id" = $1`, values: ['p1'] },
      { text: `${SELECT} where "products"."slug" = $1`, values: ['slug-1'] },
    ])
    expect(byId).toEqual(MAPPED)
    expect(bySlug).toEqual(MAPPED)
  })

  // Defect: an absent row answers something other than null.
  it('findById answers null for no row', async () => {
    let found: unknown = 'unset'

    await withPostgres([], (repo, store) =>
      store.read(async (tx) => {
        found = await repo.findById(tx, 'nope')
      }),
    )

    expect(found).toBeNull()
  })

  // Defect: the keyset walk restarts on each page, loses its order, or drops its bound.
  it('listPage walks by id from the cursor, and from the start without one', async () => {
    let page: unknown

    const sent = await withPostgres([ROW], (repo, store) =>
      store.read(async (tx) => {
        page = await repo.listPage(tx, { after: 'p0', limit: 5 })
        await repo.listPage(tx, { limit: 2 })
      }),
    )

    expect(sent).toEqual([
      {
        text: `${SELECT} where "products"."id" > $1 order by "products"."id" asc limit $2`,
        values: ['p0', 5],
      },
      { text: `${SELECT} order by "products"."id" asc limit $1`, values: [2] },
    ])
    expect(page).toEqual([MAPPED])
  })

  // Defect: Postgres goes back to ILIKE, loses the literal cast, drops a filter, or loses the tie-break on id.
  it('list sends a literal search inside the status, in a stable order, and maps the rows', async () => {
    let rows: unknown

    const sent = await withPostgres([ROW], (repo, store) =>
      store.read(async (tx) => {
        rows = await repo.list(tx, { q: '50%', limit: 7, offset: 3 })
        await repo.list(tx, { status: 'active', q: 'a' })
        await repo.list(tx)
      }),
    )

    expect(sent).toEqual([
      { text: `${SELECT} where ${NAME_HOLDS} ${ORDER} limit $2 offset $3`, values: ['50%', 7, 3] },
      {
        text: `${SELECT} where ("products"."status" = $1 and strpos(lower("products"."name"), lower(cast($2 as text))) > 0) ${ORDER} limit $3`,
        values: ['active', 'a', 100],
      },
      { text: `${SELECT} ${ORDER} limit $1`, values: [100] },
    ])
    expect(rows).toEqual([MAPPED])
  })

  // Defect: a default changes, a given value is lost, or a date goes out as anything but the instant.
  it('insert writes every column, with the defaults for what was not given', async () => {
    const sent = await withPostgres([], (repo, store) =>
      store.transaction(async (tx) => {
        await repo.insert(tx, product('bare'))
        await repo.insert(tx, product('full', FULL))
      }),
    )

    const text = `insert into "products" (${COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`
    const iso = CREATED.toISOString()
    expect(sent).toEqual([
      {
        text,
        values: [
          'bare',
          'slug-bare',
          'Name bare',
          '',
          '',
          'draft',
          'simple',
          '',
          '',
          '[]',
          '{}',
          iso,
          iso,
        ],
      },
      {
        text,
        values: [
          'full',
          'slug-full',
          'Name full',
          'long',
          'short',
          'active',
          'variable',
          'title',
          'meta',
          JSON.stringify(FULL.media),
          JSON.stringify(FULL.metadata),
          iso,
          iso,
        ],
      },
    ])
  })

  // Defect: a patched field never reaches Postgres, the timestamp is lost, or the update has no row key.
  it('update sets exactly the patched columns and the timestamp on that row', async () => {
    const iso = UPDATED.toISOString()

    const sent = await withPostgres([], (repo, store) =>
      store.transaction(async (tx) => {
        await repo.update(tx, 'p1', { updatedAt: UPDATED })
        await repo.update(tx, 'p1', {
          name: 'N',
          description: 'D',
          shortDescription: 'S',
          status: 'archived',
          type: 'variable',
          seoTitle: 'T',
          seoDescription: 'M',
          media: [],
          metadata: { a: 1 },
          updatedAt: UPDATED,
        })
      }),
    )

    expect(sent).toEqual([
      {
        text: 'update "products" set "updated_at" = $1 where "products"."id" = $2',
        values: [iso, 'p1'],
      },
      {
        text: 'update "products" set "name" = $1, "description" = $2, "short_description" = $3, "status" = $4, "type" = $5, "seo_title" = $6, "seo_description" = $7, "media" = $8, "metadata" = $9, "updated_at" = $10 where "products"."id" = $11',
        values: ['N', 'D', 'S', 'archived', 'variable', 'T', 'M', '[]', '{"a":1}', iso, 'p1'],
      },
    ])
  })

  // Defect: a status change loses its timestamp, or a delete or status change has no row key.
  it('setStatus and delete touch only that row', async () => {
    const sent = await withPostgres([], (repo, store) =>
      store.transaction(async (tx) => {
        await repo.setStatus(tx, 'p1', 'active', UPDATED)
        await repo.delete(tx, 'p1')
      }),
    )

    expect(sent).toEqual([
      {
        text: 'update "products" set "status" = $1, "updated_at" = $2 where "products"."id" = $3',
        values: ['active', UPDATED.toISOString(), 'p1'],
      },
      { text: 'delete from "products" where "products"."id" = $1', values: ['p1'] },
    ])
  })
})
