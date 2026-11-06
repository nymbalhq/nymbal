import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCommandStore, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { createEventBuilder } from '../../src/events/builder.js'
import { buildRepositories, type Repositories } from '../../src/repositories/index.js'
import { TEST_BUILDER_CONTEXT } from '../../src/tests/publisher.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import {
  createDatabase,
  postgresServerUrl,
  queryOnce,
  type TestDatabase,
} from '../support/postgres.js'

// Event retention's delete on Postgres: rows are dated through the repository's own `at` arguments, each run on an
// emptied log. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)
const T0 = new Date('2026-01-01T00:00:00.000Z')
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000)

let db: TestDatabase
let store: CommandStore
let repos: Repositories

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'retention')
  store = createCommandStore(kernelConfig('postgres'), { postgresUrl: db.url })
  await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
})

afterAll(async () => {
  await store?.close()
  await db?.drop()
})

describe('event retention on Postgres', () => {
  it('AC-5: property: on Postgres, deleteDeliveredBefore leaves every row that is delivered and dead, at any delivered age, and deletes exactly the delivered, not-dead rows delivered before the cutoff, counting only those', async () => {
    const arbRow = fc.record({
      delivered: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
      dead: fc.boolean(),
    })
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbRow, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 21 }),
        async (specs, cutoff) => {
          await queryOnce(db.url, 'DELETE FROM events')
          const events = specs.map((_, i) => makeEvent('order.created.v1', { i }))
          await store.transaction(async (tx) => {
            await repos.eventLog.append(tx, events)
            for (const [i, spec] of specs.entries()) {
              const id = events[i]!.id
              if (spec.delivered !== null) {
                await repos.eventLog.markDelivered(tx, [id], minutes(spec.delivered))
              }
              if (spec.dead) {
                await repos.eventLog.recordFailure(tx, id, minutes(spec.delivered ?? 0), 1)
              }
            }
          })
          const goes = (spec: (typeof specs)[number]): boolean =>
            spec.delivered !== null && !spec.dead && spec.delivered < cutoff

          const deleted = await store.transaction((tx) =>
            repos.eventLog.deleteDeliveredBefore(tx, minutes(cutoff)),
          )
          const left = new Set(
            (await queryOnce<{ id: string }>(db.url, 'SELECT id FROM events')).map((r) => r.id),
          )

          expect(
            events.map((e) => left.has(e.id)),
            `kept, cutoff at minute ${cutoff}: ${JSON.stringify(specs)}`,
          ).toEqual(specs.map((spec) => !goes(spec)))
          expect(deleted, 'the count deleteDeliveredBefore answers').toBe(specs.length - left.size)
        },
      ),
      {
        numRuns: 25,
        examples: [
          [
            [
              { delivered: 1, dead: true },
              { delivered: 2, dead: false },
              { delivered: 12, dead: true },
            ],
            10,
          ],
        ],
      },
    )
  }, 60_000)
})
