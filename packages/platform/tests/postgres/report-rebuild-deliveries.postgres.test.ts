import { performance } from 'node:perf_hooks'
import type { NymbalEvent } from '@nymbalhq/types'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresDb } from '../../src/db/command-store.js'
import { recompute } from '../../src/reports/fold.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  QUIET_RELAY,
  expectedHeldFrom,
  heldOnly,
  loggedRollupEvents,
  oldestCreatedAt,
} from '../support/report-rebuild.js'
import { rebuildOn } from '../support/report-rebuild-run.js'
import {
  ZONE,
  addDays,
  canonicalRollups,
  deliver,
  events,
  noonOf,
  seedPool,
  storeDay,
  storedRollups,
  type Pool,
} from '../support/report-rollups.js'
import { unaudited } from '../support/write-audit.js'

// Deliveries that commit while a rebuild runs on Postgres: none is erased by the rebuild's replace, none counts twice,
// and the two never deadlock.

const serverUrl = postgresServerUrl()
let db: TestDatabase
let k: Kernel
let raw: RawReader
let pool: Pool

const SEEDED = 4_000
const WORKERS = 4

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'report_rebuild_deliveries')
  k = await createKernel({ dialect: 'postgres', postgresUrl: db.url, appOptions: QUIET_RELAY })
  raw = openRaw(k.dialect, k.target)
  pool = await seedPool(k)
  await k.app.relay.drain()
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await k?.close()
  await db?.drop()
})

describe('AC-5: deliveries during a rebuild (postgres)', () => {
  it('AC-5: deliveries that start while a rebuild runs all settle without an error, and afterwards the held days equal a recompute of the whole log', async () => {
    const today = storeDay(new Date())
    const gbp = pool.orders.find((o) => o.currency === 'GBP' && o.source === 'storefront')!
    const kinds = [
      (i: number, at: Date) => events.searched(`term ${i % 50}`, at),
      (i: number, at: Date) => events.viewed(`viewer-${i % 200}`, at),
      (i: number, at: Date) => events.captured(gbp, 100 + (i % 7), at),
    ]
    const seeded = Array.from({ length: SEEDED }, (_, i) =>
      kinds[i % kinds.length]!(
        i,
        new Date(noonOf(addDays(today, -8 + (i % 7))).getTime() + (i % 600) * 1_000),
      ),
    )
    // Delivered before reports existed: appended when they happened, never handed to the report handler.
    await unaudited(() =>
      k.store.transaction(async (tx) => {
        const above = await k.repos.eventLog.maxSeq(tx)
        await k.repos.eventLog.append(tx, seeded)
        await postgresDb(tx).execute(
          sql`UPDATE events SET created_at = (envelope->>'timestamp')::timestamptz,
                                delivered_at = (envelope->>'timestamp')::timestamptz + interval '1 second'
              WHERE seq > ${above}`,
        )
      }),
    )
    const from = expectedHeldFrom(new Date(), 30, await oldestCreatedAt(raw))!

    let n = 0
    const nextEvent = (): NymbalEvent<unknown> => {
      n += 1
      return kinds[n % kinds.length]!(SEEDED + n, noonOf(addDays(today, -1 - (n % 5))))
    }
    const starts: number[] = []
    let done = false
    let rebuildEnded = Number.POSITIVE_INFINITY

    const began = performance.now()
    const rebuilt = rebuildOn(k, 30).finally(() => {
      rebuildEnded = performance.now()
      done = true
    })
    const workers = Array.from({ length: WORKERS }, async () => {
      while (!done) {
        const event = nextEvent()
        starts.push(performance.now())
        // As a command does: appended in its own transaction, then handed to the handler.
        await unaudited(() => k.store.transaction((tx) => k.repos.eventLog.append(tx, [event])))
        await deliver(k, event)
      }
    })
    const settled = await Promise.allSettled([rebuilt, ...workers])

    expect(
      settled
        .filter((s) => s.status === 'rejected')
        .map((s) => String((s as PromiseRejectedResult).reason)),
    ).toEqual([])
    const inside = starts.filter((t) => t > began && t < rebuildEnded)
    expect(inside.length, 'a delivery started while the rebuild ran').toBeGreaterThanOrEqual(1)
    const expected = heldOnly(
      canonicalRollups(recompute(await loggedRollupEvents(raw), pool.lookup, ZONE)),
      from,
    )
    expect(heldOnly(await storedRollups(raw), from)).toEqual(expected)
  }, 180_000)
})
