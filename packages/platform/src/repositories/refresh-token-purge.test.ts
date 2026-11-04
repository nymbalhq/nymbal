import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type {
  RefreshTokenInsert,
  RefreshTokenRepository,
  RefreshTokenRow,
} from './refresh-token.js'

// purgeRotated deletes the rows a refresh can only answer with "replayed": rotated (a successor is recorded) before
// the cutoff. Heads, rows revoked with no successor (logout, sign-out of every session) and rotated rows at or after
// the cutoff stay as they were. Rotation and logout stamp `revokedAt` from the clock, so the clock is faked (Date only)
// to place each row either side of the cutoff; `createdAt` and `expiresAt` are set either side too, so a predicate on
// the wrong column is caught.

const T0 = Date.parse('2026-06-01T09:00:00.000Z')
const HOUR_MS = 3_600_000
const CUSTOMERS = ['customer-a', 'customer-b', 'customer-c'] as const

let store: CommandStore
let repo: RefreshTokenRepository

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  repo = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 })).refreshToken
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  await store?.close()
})

type Kind = 'head' | 'rotated' | 'logout'

/** Offsets from the cutoff, with its edge and the millisecond either side drawn often. */
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

function tokenAt(customerId: string, cutoff: number, spec: Spec): RefreshTokenInsert {
  return {
    id: uuidv7(),
    customerId,
    tokenHash: uuidv7(),
    createdAt: new Date(cutoff + spec.createdOffset),
    expiresAt: new Date(cutoff + spec.expiresOffset),
  }
}

const readRows = (ids: string[]): Promise<(RefreshTokenRow | null)[]> =>
  store.read(async (tx) => {
    const out: (RefreshTokenRow | null)[] = []
    for (const id of ids) out.push(await repo.findById(tx, id))
    return out
  })

describe('AC-1: purgeRotated deletes exactly the rotated rows revoked before the cutoff', () => {
  it('AC-1: property: purgeRotated(cutoff) deletes the rows with a successor revoked before the cutoff and returns their count; heads, logout-revoked rows of any age and rotated rows at or after the cutoff are left unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 })
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbRow, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 30 * 24 * HOUR_MS }),
        async (specs, cutoffShift) => {
          const cutoff = T0 + cutoffShift
          await store.transaction(async (tx) => {
            for (const customer of CUSTOMERS) await repo.deleteByCustomer(tx, customer)
          })

          const rows = specs.map((spec) => ({ spec, token: tokenAt(spec.customer, cutoff, spec) }))
          await store.transaction(async (tx) => {
            for (const { token } of rows) await repo.insert(tx, token)
          })
          const successors: string[] = []
          for (const { spec, token } of rows) {
            if (spec.kind === 'head') continue
            vi.setSystemTime(cutoff + spec.revokedOffset)
            if (spec.kind === 'logout') {
              await store.transaction((tx) => repo.revoke(tx, token.id))
            } else {
              const next = tokenAt(spec.customer, cutoff, spec)
              successors.push(next.id)
              await store.transaction((tx) => repo.rotate(tx, token.id, next))
            }
          }

          const ids = [...rows.map((r) => r.token.id), ...successors]
          const goes = [
            ...rows.map((r) => r.spec.kind === 'rotated' && r.spec.revokedOffset < 0),
            ...successors.map(() => false),
          ]
          const before = await readRows(ids)

          vi.setSystemTime(cutoff + 72 * HOUR_MS)
          const deleted = await store.transaction((tx) => repo.purgeRotated(tx, new Date(cutoff)))
          const after = await readRows(ids)

          expect(
            after.map((row) => row === null),
            `deleted, cutoff at T0+${cutoffShift} ms: ${JSON.stringify(specs)}`,
          ).toEqual(goes)
          expect(
            after.filter((row) => row !== null),
            'every row left is as it was before the purge',
          ).toEqual(before.filter((_, i) => !goes[i]))
          expect(deleted, 'the count purgeRotated answers').toBe(goes.filter(Boolean).length)
        },
      ),
      {
        numRuns: 60,
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
