import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { CustomerRepository } from './customer.js'

// A sign-up under `required` is stored `pending` and becomes `verified` once confirmed; every other account leaves the
// column null (never asked). The mail-health funnel counts, among accounts created in [since, until), those asked to
// confirm and those that did; the admin read carries the state so the customer page can offer support its buttons.

const DAY_MS = 24 * 60 * 60_000
const SINCE = Date.parse('2026-11-01T00:00:00.000Z')
const UNTIL = SINCE + 7 * DAY_MS

type State = 'never-asked' | 'pending' | 'verified'

let store: CommandStore
let repo: CustomerRepository

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  repo = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 })).customer
})

afterAll(async () => {
  await store?.close()
})

/** Writes an account as a sign-up leaves it: inserted pending (or not asked), then confirmed by an update. */
async function account(state: State, createdAt: Date): Promise<string> {
  const id = uuidv7()
  await store.transaction(async (tx) => {
    await repo.insert(tx, {
      id,
      email: `${id}@test.com`,
      passwordHash: 'hash',
      ...(state !== 'never-asked' && { emailVerification: 'pending' as const }),
      createdAt,
      updatedAt: createdAt,
    })
    if (state === 'verified') {
      await repo.update(tx, id, { emailVerification: 'verified', updatedAt: createdAt })
    }
  })
  return id
}

/** Offsets from the window's start, with both of its edges and the millisecond either side drawn often. */
const offsetMs = fc.oneof(
  fc.constantFrom(-1, 0, 1, UNTIL - SINCE - 1, UNTIL - SINCE, UNTIL - SINCE + 1),
  fc.integer({ min: -3 * DAY_MS, max: 10 * DAY_MS }),
)
const state = fc.constantFrom<State>('never-asked', 'pending', 'verified')

describe('customer repository: email verification', () => {
  it('AC-13: property: the funnel counts the accounts created in [since, until) that were asked to confirm, and of those the confirmed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ offset: offsetMs, state }), { maxLength: 12 }),
        async (accounts) => {
          const ids: string[] = []
          try {
            for (const a of accounts) ids.push(await account(a.state, new Date(SINCE + a.offset)))
            const inWindow = accounts.filter((a) => a.offset >= 0 && SINCE + a.offset < UNTIL)
            const funnel = await store.read((tx) =>
              repo.verificationFunnel(tx, new Date(SINCE), new Date(UNTIL)),
            )
            expect(funnel).toEqual({
              started: inWindow.filter((a) => a.state !== 'never-asked').length,
              verified: inWindow.filter((a) => a.state === 'verified').length,
            })
          } finally {
            await store.transaction(async (tx) => {
              for (const id of ids) await repo.delete(tx, id)
            })
          }
          // A deleted account is counted nowhere, so the next run starts from an empty table.
          expect(
            await store.read((tx) =>
              repo.verificationFunnel(tx, new Date(SINCE - DAY_MS), new Date(UNTIL + DAY_MS)),
            ),
          ).toEqual({ started: 0, verified: 0 })
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-24: every read of an account carries the state its sign-up left, and a never-asked account carries none', async () => {
    const at = new Date(SINCE)
    const written = {
      'never-asked': await account('never-asked', at),
      pending: await account('pending', at),
      verified: await account('verified', at),
    }
    try {
      for (const [state, id] of Object.entries(written)) {
        const expected = state === 'never-asked' ? undefined : state
        const [byId, byEmail, listed] = await store.read(async (tx) => [
          await repo.findById(tx, id),
          await repo.findByEmail(tx, `${id.toUpperCase()}@TEST.COM`),
          (await repo.list(tx)).find((c) => c.id === id),
        ])
        for (const read of [byId, byEmail, listed]) {
          expect(read?.id).toBe(id)
          expect(read?.emailVerification).toBe(expected)
          expect(Object.hasOwn(read!, 'emailVerification')).toBe(expected !== undefined)
        }
      }
    } finally {
      await store.transaction(async (tx) => {
        for (const id of Object.values(written)) await repo.delete(tx, id)
      })
    }
  })
})
