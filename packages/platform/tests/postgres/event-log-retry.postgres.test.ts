import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandStore, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { buildRepositories, type Repositories } from '../../src/repositories/index.js'
import {
  arbRetryScenario,
  boundsOf,
  countDeadOf,
  deadMatching,
  listDeadOf,
  retryDeadOf,
  retryExpected,
  SCENARIO_EXAMPLE,
  seedRetryLog,
  selectionOf,
  type RetryLogEnv,
} from '../../src/tests/event-retry.js'
import type { LoggedEvent } from '../../src/repositories/event-log.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import {
  createDatabase,
  postgresServerUrl,
  queryOnce,
  type TestDatabase,
} from '../support/postgres.js'

// Retrying dead events on Postgres: the same generated logs and in-memory selection as the SQLite tests, type globs
// with `_` and `%` included, and concurrent retries over one set of rows. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

let db: TestDatabase
let store: CommandStore
let repos: Repositories
let env: RetryLogEnv

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'retry_dead')
  store = createCommandStore(kernelConfig('postgres'), { postgresUrl: db.url })
  await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  env = {
    store,
    log: repos.eventLog,
    async append(events, at) {
      vi.setSystemTime(at)
      await store.transaction((tx) => repos.eventLog.append(tx, events))
    },
    dump: async () =>
      (await queryOnce(db.url, 'SELECT * FROM events ORDER BY seq')) as Array<
        Record<string, unknown>
      >,
  }
})

afterAll(async () => {
  await store?.close()
  await db?.drop()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const ids = (rows: LoggedEvent[]): string[] => rows.map((r) => r.event.id)
const all = (): Promise<LoggedEvent[]> => store.read((tx) => repos.eventLog.listAll(tx))
const empty = async (): Promise<void> => {
  await queryOnce(db.url, 'DELETE FROM events')
}

describe('event log: retrying dead events on Postgres', () => {
  it('AC-2: property: on Postgres, over any log and any selection, type globs with _ and % included, retryDead returns exactly the dead rows the selection takes with created_at at or after the floor, the oldest limit of them; each now has dead_at and retry_at null, attempts 0 and its delivered_at unchanged; every other row is unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(arbRetryScenario, async (s) => {
        await empty()
        await seedRetryLog(env, s.rows)
        const before = await all()
        const beforeRaw = new Map((await env.dump()).map((r) => [Number(r['seq']), r]))
        const selection = selectionOf(s, before)
        const bounds = boundsOf(s)
        const expected = retryExpected(before, selection, bounds)

        const got = await store.transaction((tx) =>
          retryDeadOf(repos.eventLog)(tx, selection, bounds),
        )

        expect(ids(got), JSON.stringify({ selection, bounds })).toEqual(ids(expected))
        const moved = new Set(expected.map((r) => r.seq))
        const isMoved = (r: Record<string, unknown>) => moved.has(Number(r['seq']))
        const after = await env.dump()
        expect(
          after
            .filter(isMoved)
            .map((r) => [r['dead_at'], r['retry_at'], Number(r['attempts']), r['delivered_at']]),
          'the rows moved',
        ).toEqual(
          after
            .filter(isMoved)
            .map((r) => [null, null, 0, beforeRaw.get(Number(r['seq']))!['delivered_at']]),
        )
        expect(
          after.filter((r) => !isMoved(r)),
          "the rows that are not the retry's to change",
        ).toEqual(before.map((r) => beforeRaw.get(r.seq)!).filter((r) => !isMoved(r)))
      }),
      { numRuns: 25, examples: [[SCENARIO_EXAMPLE]] },
    )
  }, 180_000)

  it('AC-2: property: on Postgres, countDead and listDead with a selection agree with the same selection done in memory, type globs with _ and % included, and a `_` in a glob matches only an underscore', async () => {
    await fc.assert(
      fc.asyncProperty(arbRetryScenario, async (s) => {
        await empty()
        await seedRetryLog(env, s.rows)
        const before = await all()
        const selection = selectionOf(s, before)
        const expected = deadMatching(before, selection)

        const counted = await store.read((tx) => countDeadOf(repos.eventLog)(tx, selection))
        const listed = await store.read((tx) => listDeadOf(repos.eventLog)(tx, s.limit, selection))

        expect(counted, JSON.stringify(selection)).toBe(expected.length)
        expect(ids(listed), JSON.stringify(selection)).toEqual(ids(expected.slice(0, s.limit)))
      }),
      {
        numRuns: 25,
        examples: [[{ ...SCENARIO_EXAMPLE, types: ['a_c.v1'], limit: 16 }]],
      },
    )
  }, 180_000)

  it('AC-3: property: on Postgres, k concurrent retryDead calls over the same dead rows move each row exactly once: the rows returned are disjoint and together are the dead rows selected', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 1, max: 12 }),
        fc.nat({ max: 3 }),
        async (k, deadCount, waitingCount) => {
          await empty()
          const rows = [
            ...Array.from({ length: deadCount }, (_, i) => ({
              kind: 'dead' as const,
              type: 'order.created.v1',
              minute: i % 5,
              attempts: 2,
            })),
            ...Array.from({ length: waitingCount }, () => ({
              kind: 'waiting' as const,
              type: 'order.created.v1',
              minute: 0,
              attempts: 1,
            })),
          ]
          await seedRetryLog(env, rows)
          const before = await all()
          const bounds = { floor: new Date(0), limit: 100 }
          const retry = retryDeadOf(repos.eventLog)

          const returned = await Promise.all(
            Array.from({ length: k }, () => store.transaction((tx) => retry(tx, {}, bounds))),
          )

          const flat = returned.flat().map((r) => r.event.id)
          expect(new Set(flat).size, 'a row returned by two retries').toBe(flat.length)
          expect(flat.length, `${k} retries over ${deadCount} dead rows`).toBe(deadCount)
          expect([...flat].sort(), 'the rows returned are the dead rows selected').toEqual(
            ids(before.filter((r) => r.deadAt !== null)).sort(),
          )
          const after = await all()
          expect(
            after.filter((r) => r.deadAt !== null).map((r) => r.seq),
            'still dead',
          ).toEqual([])
        },
      ),
      { numRuns: 20 },
    )
  }, 180_000)
})
