import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { sql } from 'drizzle-orm'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore, sqliteDb } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { createEventBuilder } from '../events/builder.js'
import { TEST_BUILDER_CONTEXT } from '../tests/publisher.js'
import {
  arbRetryScenario,
  boundsOf,
  countDeadOf,
  deadMatching,
  listDeadOf,
  minutes,
  retryDeadOf,
  retryExpected,
  retryFloorOf,
  SCENARIO_EXAMPLE,
  seedRetryLog,
  selectionOf,
  type RetryLogEnv,
} from '../tests/event-retry.js'
import { buildRepositories } from './index.js'
import type { LoggedEvent } from './event-log.js'

// Retrying dead events on SQLite: each retry is checked against the same selection done in memory over `listAll`,
// and every row a retry must leave alone against its stored columns from before.

const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)
const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

async function setup(): Promise<RetryLogEnv & { close(): Promise<void> }> {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const log = repos.eventLog
  return {
    store,
    log,
    async append(events, at) {
      vi.setSystemTime(at)
      await store.transaction((tx) => log.append(tx, events))
    },
    dump: () =>
      store.read(
        async (tx) =>
          sqliteDb(tx).all(sql`SELECT * FROM events ORDER BY seq`) as Array<
            Record<string, unknown>
          >,
      ),
    close: () => store.close(),
  }
}

const ids = (rows: LoggedEvent[]): string[] => rows.map((r) => r.event.id)
const all = (env: RetryLogEnv): Promise<LoggedEvent[]> =>
  env.store.read((tx) => env.log.listAll(tx))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('event log: retryDead on SQLite', () => {
  it('AC-1: property: over any log and any selection, retryDead returns exactly the dead rows the selection takes with created_at at or after the floor, the oldest limit of them; each now has dead_at and retry_at null, attempts 0 and its delivered_at unchanged; every other row is unchanged to the byte', async () => {
    await fc.assert(
      fc.asyncProperty(arbRetryScenario, async (s) => {
        const env = await setup()
        try {
          await seedRetryLog(env, s.rows)
          const before = await all(env)
          const beforeRaw = new Map((await env.dump()).map((r) => [Number(r['seq']), r]))
          const selection = selectionOf(s, before)
          const bounds = boundsOf(s)
          const expected = retryExpected(before, selection, bounds)

          const got = await env.store.transaction((tx) =>
            retryDeadOf(env.log)(tx, selection, bounds),
          )

          expect(ids(got), JSON.stringify({ selection, bounds })).toEqual(ids(expected))
          for (const row of got) {
            expect([row.deadAt, row.attempts], `the row returned for seq ${row.seq}`).toEqual([
              null,
              0,
            ])
          }
          const moved = new Set(expected.map((r) => r.seq))
          const isMoved = (r: Record<string, unknown>) => moved.has(Number(r['seq']))
          const after = await env.dump()
          expect(
            after
              .filter(isMoved)
              .map((r) => [r['dead_at'], r['retry_at'], r['attempts'], r['delivered_at']]),
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
        } finally {
          await env.close()
        }
      }),
      { numRuns: 40, examples: [[SCENARIO_EXAMPLE]] },
    )
  }, 120_000)

  it('AC-1: a dead row appended exactly at the floor is taken and one appended a millisecond before it is not', async () => {
    const env = await setup()
    try {
      const floor = minutes(10)
      const before = makeEvent('order.created.v1', { n: 'before' })
      const at = makeEvent('order.created.v1', { n: 'at' })
      const after = makeEvent('order.created.v1', { n: 'after' })
      await env.append([before], new Date(floor.getTime() - 1))
      await env.append([at], floor)
      await env.append([after], new Date(floor.getTime() + 1))
      await env.store.transaction(async (tx) => {
        for (const e of [before, at, after]) {
          await env.log.recordFailure(tx, e.id, minutes(20), 1, minutes(30))
        }
      })

      const got = await env.store.transaction((tx) =>
        retryDeadOf(env.log)(tx, {}, { floor, limit: 10 }),
      )

      expect(ids(got)).toEqual([at.id, after.id])
      const left = (await all(env)).filter((r) => r.deadAt !== null).map((r) => r.event.id)
      expect(left, 'the rows still dead').toEqual([before.id])
    } finally {
      await env.close()
    }
  })

  it('AC-1: a row that retryDead has moved is not moved by a second retry, which returns nothing and leaves the row as the first retry did', async () => {
    const env = await setup()
    try {
      const event = makeEvent('order.created.v1', {})
      await env.append([event], minutes(1))
      await env.store.transaction((tx) => env.log.recordFailure(tx, event.id, minutes(2), 1))
      const bounds = { floor: minutes(0), limit: 10 }
      const retry = retryDeadOf(env.log)

      const first = await env.store.transaction((tx) => retry(tx, {}, bounds))
      const afterFirst = await env.dump()
      const second = await env.store.transaction((tx) => retry(tx, {}, bounds))

      expect(ids(first)).toEqual([event.id])
      expect(ids(second)).toEqual([])
      expect(await env.dump(), 'a second retry changed the row').toEqual(afterFirst)
    } finally {
      await env.close()
    }
  })

  it('AC-1: property: countDead and listDead with a selection agree with the same selection done in memory, oldest first, cut at the limit', async () => {
    await fc.assert(
      fc.asyncProperty(arbRetryScenario, async (s) => {
        const env = await setup()
        try {
          await seedRetryLog(env, s.rows)
          const before = await all(env)
          const selection = selectionOf(s, before)
          const expected = deadMatching(before, selection)

          const counted = await env.store.read((tx) => countDeadOf(env.log)(tx, selection))
          const listed = await env.store.read((tx) => listDeadOf(env.log)(tx, s.limit, selection))

          expect(counted, JSON.stringify(selection)).toBe(expected.length)
          expect(ids(listed), JSON.stringify(selection)).toEqual(ids(expected.slice(0, s.limit)))
        } finally {
          await env.close()
        }
      }),
      {
        numRuns: 40,
        examples: [[{ ...SCENARIO_EXAMPLE, types: ['order.*'] }]],
      },
    )
  }, 120_000)
})

describe('retryFloor', () => {
  it('AC-18: property: retryFloor(now, r) is now less r days plus one hour, to the millisecond', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3650 }),
        fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) }),
        (retentionDays, now) => {
          expect(
            retryFloorOf(new Date(now), retentionDays).getTime(),
            `r = ${retentionDays}`,
          ).toBe(now - retentionDays * DAY_MS + HOUR_MS)
        },
      ),
      { numRuns: 200, examples: [[30, Date.UTC(2026, 10, 9, 12, 0, 0, 1)]] },
    )
  })
})
