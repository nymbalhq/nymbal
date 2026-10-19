import { describe, it, expect } from 'vitest'
import {
  createCommandStore,
  rawClients,
  runMigrations,
  type CommandStore,
} from '@nymbalhq/platform'

async function buildStore(): Promise<CommandStore> {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../packages/platform/migrations', import.meta.url).pathname,
  })
  return store
}

function sqlite(store: CommandStore) {
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') throw new Error(`expected a sqlite store, got ${clients.kind}`)
  return clients.raw
}

describe('CommandStore contract — SQLite', () => {
  it('creates and closes a connection without error', async () => {
    const store = await buildStore()
    expect(store.kind).toBe('sqlite')
    await expect(store.close()).resolves.not.toThrow()
  })

  it('transaction commits successfully', async () => {
    const store = await buildStore()
    let ran = false
    await store.transaction(async () => {
      ran = true
    })
    expect(ran).toBe(true)
    await store.close()
  })

  it('schema is migrated — products table exists', async () => {
    const store = await buildStore()
    expect(store.kind).toBe('sqlite')
    const result = sqlite(store)
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'")
      .get()
    expect(result).toEqual({ name: 'products' })
    await store.close()
  })

  it('rows written inside a transaction read back equal after it commits', async () => {
    const store = await buildStore()
    const raw = sqlite(store)
    const written = [
      { id: 'cat-2', slug: 'home', name: 'Home', position: 1 },
      { id: 'cat-1', slug: 'books', name: 'Books', position: 2 },
    ]
    await store.transaction(async () => {
      const insert = raw.prepare(
        "INSERT INTO categories (id, slug, name, position, created_at) VALUES (@id, @slug, @name, @position, '2026-10-17T00:00:00.000Z')",
      )
      for (const row of written) insert.run(row)
    })
    const read = raw.prepare('SELECT id, slug, name, position FROM categories ORDER BY id').all()
    expect(read).toEqual([...written].sort((a, b) => a.id.localeCompare(b.id)))
    await store.close()
  })

  it('concurrent reads do not throw', async () => {
    const store = await buildStore()
    const reads = Array.from({ length: 5 }, () => store.read(async () => ({ ok: true })))
    const results = await Promise.all(reads)
    expect(results.every((r) => r.ok)).toBe(true)
    await store.close()
  })
})
