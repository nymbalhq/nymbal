import { describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { RefreshTokenInsert } from './refresh-token.js'

// Removing an imported customer ends that customer's sessions and nobody else's.

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
  return { store, repo: repos.refreshToken }
}
type Env = Awaited<ReturnType<typeof setup>>

function token(customerId: string): RefreshTokenInsert {
  const createdAt = new Date(Date.UTC(2026, 9, 1, 10, 0, 0))
  return {
    id: uuidv7(),
    customerId,
    tokenHash: uuidv7(),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 86_400_000),
  }
}

const rows = (env: Env, tokens: RefreshTokenInsert[]) =>
  env.store.read(async (tx) => {
    const out = []
    for (const t of tokens) out.push(await env.repo.findById(tx, t.id))
    return out
  })

describe('RefreshTokenRepository: removal by customer', () => {
  // Defect: the delete loses its customer condition (rolling one imported customer back signs every customer out) or
  // deletes nothing (the removed customer's tokens stay behind).
  it('deleteByCustomer removes the tokens of that customer and leaves every other customer’s as they were', async () => {
    const env = await setup()
    const [gone, kept] = [uuidv7(), uuidv7()]
    const goneTokens = [token(gone), token(gone)]
    const keptTokens = [token(kept), token(kept)]
    await env.store.transaction(async (tx) => {
      for (const t of [...goneTokens, ...keptTokens]) await env.repo.insert(tx, t)
    })
    // One of the kept customer's tokens revoked, so "as they were" covers a row that is not fresh.
    await env.store.transaction((tx) => env.repo.revoke(tx, keptTokens[0]!.id))
    const keptBefore = await rows(env, keptTokens)

    await env.store.transaction((tx) => env.repo.deleteByCustomer(tx, gone))

    expect(await rows(env, goneTokens)).toEqual(goneTokens.map(() => null))
    expect(await rows(env, keptTokens)).toEqual(keptBefore)
    await env.store.close()
  })
})
