import fc from 'fast-check'
import type { Role } from '@nymbalhq/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { CustomerInsert, CustomerRepository, CustomerWithHash } from './customer.js'

// A customer search answers the accounts with the customer role whose email, first name or last name holds the term,
// literally (% and _ are themselves) and case folded in any script, by creation time then id, cut to the limit.

const CREATED = Date.parse('2026-10-01T10:00:00.000Z')

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

describe('CustomerRepository.search on SQLite', () => {
  // Defect: LIKE (a wildcard matches everything), lower() folding ASCII alone, a column left out of the match, a staff
  // account without the customer role answered, another order, or the limit taken before the match.
  it('AC-4: property: a search returns exactly the customer-role accounts whose email, first or last name holds the term, literally and case folded, by creation time then id, cut to the limit', async () => {
    const unit = fc.constantFrom('a', 'A', 'é', 'É', '%', '_', "'", 'x')
    const roles = fc.constantFrom<Role[]>(['customer'], ['admin'], ['admin', 'customer'])
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            local: fc.string({ unit, maxLength: 4 }),
            firstName: fc.string({ unit, maxLength: 4 }),
            lastName: fc.string({ unit, maxLength: 4 }),
            roles,
            second: fc.integer({ min: 0, max: 2 }),
          }),
          { maxLength: 8 },
        ),
        fc.string({ unit: fc.constantFrom('a', 'É', '%', '_', "'"), minLength: 1, maxLength: 2 }),
        fc.integer({ min: 1, max: 9 }),
        async (rows, q, limit) => {
          // Ids run against insertion order, and the email's suffix shares no character with the term's alphabet.
          const inserted: CustomerInsert[] = rows.map((r, i) => {
            const id = `c${String(rows.length - i).padStart(2, '0')}`
            const createdAt = new Date(CREATED + r.second * 1000)
            return {
              id,
              email: `${r.local}-${id}@x.test`,
              passwordHash: 'hash',
              firstName: r.firstName,
              lastName: r.lastName,
              roles: r.roles,
              createdAt,
              updatedAt: createdAt,
            }
          })
          await store.transaction(async (tx) => {
            for (const row of await repo.list(tx)) await repo.delete(tx, row.id)
            for (const row of inserted) await repo.insert(tx, row)
          })

          const holds = (text: string) => text.toLowerCase().includes(q.toLowerCase())
          const expected = inserted
            .filter((r) => r.roles!.includes('customer'))
            .filter((r) => holds(r.email) || holds(r.firstName!) || holds(r.lastName!))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
            .slice(0, limit)
            .map((r) => r.id)

          const found = await store.read<CustomerWithHash[]>((tx) => repo.search(tx, { q, limit }))

          expect(found.map((c) => c.id)).toEqual(expected)
        },
      ),
      { numRuns: 80 },
    )
  })
})
