import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCommandStore, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { buildRepositories, type Repositories } from '../../src/repositories/index.js'
import type { RefreshTokenInsert } from '../../src/repositories/refresh-token.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import {
  createDatabase,
  postgresServerUrl,
  queryOnce,
  type TestDatabase,
} from '../support/postgres.js'

// purgeRotated's delete on Postgres, each run on an emptied table. Rotation and logout stamp `revokedAt` from the
// clock, so the clock is faked (Date only) to place each row either side of the cutoff; `createdAt` and `expiresAt`
// sit either side too. What is left is read on a second connection. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const T0 = Date.parse('2026-06-01T09:00:00.000Z')
const HOUR_MS = 3_600_000
const CUSTOMERS = ['customer-a', 'customer-b', 'customer-c'] as const

let db: TestDatabase
let store: CommandStore
let repos: Repositories

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'refresh_purge')
  store = createCommandStore(kernelConfig('postgres'), { postgresUrl: db.url })
  await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  await store?.close()
  await db?.drop()
})

type Kind = 'head' | 'rotated' | 'logout'

const offsetMs = fc.oneof(
  fc.constantFrom(-1, 0, 1),
  fc.integer({ min: -48 * HOUR_MS, max: 48 * HOUR_MS }),
)

const arbRow = fc.record({
  kind: fc.constantFrom<Kind>('head', 'rotated', 'logout'),
  customer: fc.constantFrom(...CUSTOMERS),
  revokedOffset: offsetMs,
  createdOffset: offsetMs,
  expiresOffset: offsetMs,
})

type Spec = typeof arbRow extends fc.Arbitrary<infer T> ? T : never

function tokenAt(cutoff: number, spec: Spec): RefreshTokenInsert {
  return {
    id: uuidv7(),
    customerId: spec.customer,
    tokenHash: uuidv7(),
    createdAt: new Date(cutoff + spec.createdOffset),
    expiresAt: new Date(cutoff + spec.expiresOffset),
  }
}

type RawRow = Record<string, unknown> & { id: string }

/** Every column of every row, as a second connection sees them, keyed by id. */
async function tableById(): Promise<Map<string, RawRow>> {
  const rows = await queryOnce<RawRow>(
    db.url,
    `SELECT id, customer_id, token_hash, revoked_at::text AS revoked_at, replaced_by_jti,
            expires_at::text AS expires_at, created_at::text AS created_at
       FROM refresh_tokens`,
  )
  return new Map(rows.map((row) => [row.id, row]))
}

describe('AC-1: purgeRotated on Postgres', () => {
  it('AC-1: property: on Postgres, purgeRotated(cutoff) deletes the rows with a successor revoked before the cutoff and returns their count; heads, logout-revoked rows of any age and rotated rows at or after the cutoff are left unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 })
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbRow, { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 0, max: 30 * 24 * HOUR_MS }),
        async (specs, cutoffShift) => {
          const cutoff = T0 + cutoffShift
          await queryOnce(db.url, 'DELETE FROM refresh_tokens')

          const rows = specs.map((spec) => ({ spec, token: tokenAt(cutoff, spec) }))
          await store.transaction(async (tx) => {
            for (const { token } of rows) await repos.refreshToken.insert(tx, token)
          })
          for (const { spec, token } of rows) {
            if (spec.kind === 'head') continue
            vi.setSystemTime(cutoff + spec.revokedOffset)
            if (spec.kind === 'logout') {
              await store.transaction((tx) => repos.refreshToken.revoke(tx, token.id))
            } else {
              const next = tokenAt(cutoff, spec)
              await store.transaction((tx) => repos.refreshToken.rotate(tx, token.id, next))
            }
          }
          const goes = new Set(
            rows
              .filter((r) => r.spec.kind === 'rotated' && r.spec.revokedOffset < 0)
              .map((r) => r.token.id),
          )
          const before = await tableById()

          vi.setSystemTime(cutoff + 72 * HOUR_MS)
          const deleted = await store.transaction((tx) =>
            repos.refreshToken.purgeRotated(tx, new Date(cutoff)),
          )
          const after = await tableById()

          expect(
            [...before.keys()].filter((id) => !after.has(id)).sort(),
            `deleted, cutoff at T0+${cutoffShift} ms: ${JSON.stringify(specs)}`,
          ).toEqual([...goes].sort())
          expect([...after.values()], 'every row left is as it was before the purge').toEqual(
            [...before.values()].filter((row) => !goes.has(row.id)),
          )
          expect(deleted, 'the count purgeRotated answers').toBe(before.size - after.size)
        },
      ),
      {
        numRuns: 25,
        examples: [
          [
            [
              {
                kind: 'rotated',
                customer: 'customer-a',
                revokedOffset: -1,
                createdOffset: 1,
                expiresOffset: 1,
              },
              {
                kind: 'rotated',
                customer: 'customer-a',
                revokedOffset: 0,
                createdOffset: -1,
                expiresOffset: -1,
              },
              {
                kind: 'rotated',
                customer: 'customer-b',
                revokedOffset: 1,
                createdOffset: -1,
                expiresOffset: -1,
              },
              {
                kind: 'logout',
                customer: 'customer-b',
                revokedOffset: -HOUR_MS,
                createdOffset: -1,
                expiresOffset: 1,
              },
              {
                kind: 'logout',
                customer: 'customer-c',
                revokedOffset: HOUR_MS,
                createdOffset: -1,
                expiresOffset: 1,
              },
              {
                kind: 'head',
                customer: 'customer-c',
                revokedOffset: 0,
                createdOffset: -1,
                expiresOffset: -1,
              },
            ],
            0,
          ],
        ],
      },
    )
  }, 60_000)
})
