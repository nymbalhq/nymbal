import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { SettingRow } from './settings.js'

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
  return { store, repo: repos.settings }
}
type Env = Awaited<ReturnType<typeof setup>>

function plain(slot: string, path: string, value: string, over: Partial<SettingRow> = {}): SettingRow {
  return {
    slot,
    path,
    ciphertext: null,
    plain: value,
    iv: null,
    tag: null,
    keyId: null,
    updatedAt: new Date('2026-10-01T10:00:00.000Z'),
    updatedBy: null,
    ...over,
  }
}

function secret(slot: string, path: string, over: Partial<SettingRow> = {}): SettingRow {
  return {
    slot,
    path,
    ciphertext: Buffer.from([0, 1, 2, 250, 255]),
    plain: null,
    iv: Buffer.from('0123456789ab'),
    tag: Buffer.from('tag-of-sixteen-b'),
    keyId: 'k1',
    updatedAt: new Date('2026-10-02T11:30:00.000Z'),
    updatedBy: 'admin:3',
    ...over,
  }
}

const put = (env: Env, row: SettingRow) => env.store.transaction((tx) => env.repo.put(tx, row))
const get = (env: Env, slot: string, path: string) =>
  env.store.read((tx) => env.repo.get(tx, slot, path))
const list = (env: Env) => env.store.read((tx) => env.repo.list(tx))

describe('SettingsRepository', () => {
  // Defect: a column is dropped or mangled on the way back (the bytes of a secret, its key id, the timestamp), so
  // the value decrypted is not the one written.
  it('a secret row and a plain row read back as written, bytes as Buffers and the time as a Date', async () => {
    const env = await setup()
    const s = secret('payment', 'secretKey')
    const p = plain('payment', 'mode', 'test', { updatedBy: 'admin:1' })
    await put(env, s)
    await put(env, p)

    const readSecret = await get(env, 'payment', 'secretKey')
    expect(readSecret).toEqual(s)
    expect(Buffer.isBuffer(readSecret?.ciphertext)).toBe(true)
    expect(readSecret?.updatedAt).toBeInstanceOf(Date)
    expect(await get(env, 'payment', 'mode')).toEqual(p)
    expect(await get(env, 'payment', 'missing')).toBeUndefined()
    expect(await get(env, 'email', 'secretKey')).toBeUndefined()
    await env.store.close()
  })

  // Defect: put inserts a second row or keeps the old value instead of replacing the one at its slot and path.
  it('put replaces the row at its slot and path, and leaves the others alone', async () => {
    const env = await setup()
    await put(env, plain('payment', 'mode', 'test'))
    await put(env, plain('email', 'mode', 'smtp'))
    const replaced = secret('payment', 'mode', { keyId: 'k2' })
    await put(env, replaced)

    expect(await get(env, 'payment', 'mode')).toEqual(replaced)
    expect(await get(env, 'email', 'mode')).toEqual(plain('email', 'mode', 'smtp'))
    expect(await list(env)).toHaveLength(2)
    await env.store.close()
  })

  // Defect: delete reports a row it did not remove, or removes a row of another slot or path.
  it('delete removes only its row and answers whether one was there', async () => {
    const env = await setup()
    await put(env, plain('payment', 'mode', 'test'))
    await put(env, plain('payment', 'region', 'eu'))
    await put(env, plain('email', 'mode', 'smtp'))

    const del = (slot: string, path: string) =>
      env.store.transaction((tx) => env.repo.delete(tx, slot, path))
    expect(await del('payment', 'mode')).toBe(true)
    expect(await del('payment', 'mode')).toBe(false)
    expect(await del('search', 'mode')).toBe(false)
    expect((await list(env)).map((r) => `${r.slot}/${r.path}`)).toEqual([
      'email/mode',
      'payment/region',
    ])
    await env.store.close()
  })

  // Defect: list is unordered, or clear ignores a filter (wiping every slot) or miscounts what went.
  it('property: list is ordered by slot then path, and clear removes exactly the rows its filter selects', async () => {
    const name = fc.constantFrom('a', 'b', 'c')
    const key = fc.tuple(name, name)
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(key, { selector: ([s, p]) => `${s}/${p}`, maxLength: 9 }),
        fc.record({ slot: name, path: name }, { requiredKeys: [] }),
        async (keys, filter) => {
          const env = await setup()
          for (const [slot, path] of keys) await put(env, plain(slot, path, `${slot}:${path}`))

          const sorted = [...keys].sort(([s1, p1], [s2, p2]) =>
            s1 === s2 ? p1.localeCompare(p2) : s1.localeCompare(s2),
          )
          expect((await list(env)).map((r) => [r.slot, r.path])).toEqual(sorted)

          const selected = (slot: string, path: string) =>
            (filter.slot === undefined || filter.slot === slot) &&
            (filter.path === undefined || filter.path === path)
          const cleared = await env.store.transaction((tx) => env.repo.clear(tx, filter))
          expect(cleared).toBe(keys.filter(([s, p]) => selected(s, p)).length)
          expect((await list(env)).map((r) => [r.slot, r.path])).toEqual(
            sorted.filter(([s, p]) => !selected(s, p)),
          )
          await env.store.close()
        },
      ),
      { numRuns: 30 },
    )
  })

  it('clear with no filter removes every row', async () => {
    const env = await setup()
    await put(env, plain('payment', 'mode', 'test'))
    await put(env, secret('email', 'password'))
    expect(await env.store.transaction((tx) => env.repo.clear(tx))).toBe(2)
    expect(await list(env)).toEqual([])
    await env.store.close()
  })
})
