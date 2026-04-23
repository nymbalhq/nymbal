import { describe, it, expect, afterAll } from 'vitest'
import { createCommandStore, runMigrations, type CommandStore } from '@nymbal/platform'

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

describe('CommandStore contract — SQLite', () => {
  it('creates and closes a connection without error', async () => {
    const store = await buildStore()
    expect(store.kind).toBe('sqlite')
    await expect(store.close()).resolves.not.toThrow()
  })

  it('transaction commits successfully', async () => {
    const store = await buildStore()
    let ran = false
    await store.transaction(async () => { ran = true })
    expect(ran).toBe(true)
    await store.close()
  })

  it('schema is migrated — products table exists', async () => {
    const store = await buildStore()
    expect(store.kind).toBe('sqlite')
    if (store.kind === 'sqlite') {
      const result = store.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get()
      expect(result).toBeTruthy()
    }
    await store.close()
  })

  it('concurrent reads do not throw', async () => {
    const store = await buildStore()
    const reads = Array.from({ length: 5 }, () =>
      store.transaction(async (_db) => ({ ok: true })),
    )
    const results = await Promise.all(reads)
    expect(results.every((r) => r.ok)).toBe(true)
    await store.close()
  })
})
