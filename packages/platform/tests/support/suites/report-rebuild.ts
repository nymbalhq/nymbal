import fc from 'fast-check'
import type { NymbalEvent } from '@nymbalhq/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recompute } from '../../../src/reports/fold.js'
import type { Kernel } from '../kernel.js'
import { eventRows } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'
import {
  NOW,
  appendedAfter,
  damageArb,
  damageReports,
  expectedHeldFrom,
  heldOnly,
  logEvents,
  loggedRollupEvents,
  noEarlierThanItsOrder,
  oldestCreatedAt,
  reportRows,
  resetReports,
  withImports,
  type Damage,
  type LogEntry,
} from '../report-rebuild.js'
import { countsOf, rebuildOn } from '../report-rebuild-run.js'
import {
  AROUND_CLOCK_CHANGE,
  ROLLUP_TABLES,
  ZONE,
  canonicalRollups,
  events,
  rollupEventArb,
  seedPool,
  storeDay,
  storedRollups,
  type EventWindow,
  type Pool,
} from '../report-rollups.js'

// The rebuild on one dialect: whatever the log holds and whatever was done to the report tables, the days the log holds
// whole end up as a recompute of the log, older days as they were, and every event counts once however its delivery
// and the rebuild interleave.

const DAY_MS = 24 * 60 * 60_000

/** Any log of rollup events around the UK clock change, each delivered, undelivered or dead, some handed over live. */
function logArb(pool: Pool): fc.Arbitrary<LogEntry[]> {
  return fc.array(
    fc
      .record({
        event: rollupEventArb(pool, AROUND_CLOCK_CHANGE).map(noEarlierThanItsOrder),
        state: fc.constantFrom('delivered' as const, 'undelivered' as const, 'dead' as const),
        live: fc.boolean(),
        lagMs: fc.integer({ min: 0, max: 5 * 60_000 }),
      })
      .map(({ event, state, live, lagMs }) => ({
        event,
        state,
        live,
        createdAt: appendedAfter(event, lagMs),
      })),
    { minLength: 1, maxLength: 14 },
  )
}

/** Days 2026-10-26 to 2026-11-04: held under a 30-day retention at `NOW`. */
const HELD_WINDOW: EventWindow = { base: new Date('2026-10-26T00:00:00.000Z'), hours: 10 * 24 }

/** Rollup events no other subscription acts on, so a relay delivery reaches every handler without a failure. */
function quietEventArb(pool: Pool): fc.Arbitrary<NymbalEvent<unknown>> {
  const at = fc
    .integer({ min: 0, max: HELD_WINDOW.hours * 60 })
    .map((m) => new Date(HELD_WINDOW.base.getTime() + m * 60_000))
  const order = fc.constantFrom(...pool.orders)
  return fc.oneof(
    fc
      .tuple(order, fc.integer({ min: 1, max: 40_000 }), at)
      .map(([o, a, t]) => events.captured(o, a, t)),
    fc
      .tuple(order, fc.integer({ min: 1, max: 40_000 }), at)
      .map(([o, a, t]) => events.refunded(o, a, t)),
    fc.tuple(fc.constantFrom('viewer-a', 'viewer-b'), at).map(([v, t]) => events.viewed(v, t)),
    fc
      .tuple(fc.constantFrom('blue widget', 'unicorn mug'), at)
      .map(([s, t]) => events.searched(s, t)),
    fc.tuple(fc.constantFrom(...pool.cartTokens), at).map(([c, t]) => events.cartAdded(c, t)),
  )
}

export function reportRebuildSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  numRuns: number,
): void {
  describe(`the rebuild leaves held days equal to a recompute of the log (${dialect})`, () => {
    let k: Kernel
    let raw: RawReader
    let pool: Pool

    beforeAll(async () => {
      k = await start()
      raw = openRaw(k.dialect, k.target)
      pool = await withImports(k, await seedPool(k))
      await k.app.relay.drain()
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await k?.close()
    })

    /** The log and the damage written; answers the first held day as worked out apart from the rebuild. */
    async function arrange(
      entries: LogEntry[],
      damage: Damage,
      retentionDays: number,
    ): Promise<string> {
      await resetReports(k)
      await logEvents(k, entries)
      const from = expectedHeldFrom(NOW, retentionDays, await oldestCreatedAt(raw))
      if (from === null) throw new Error('arrange: the log holds no event')
      await damageReports(k, damage, from, NOW)
      return from
    }

    it(`AC-1: property: for any log across held and older days and any damage to the report tables, after a rebuild the held days equal a recompute of the logged events kept to those days, and every row of an older day is unchanged (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          logArb(pool),
          damageArb,
          fc.constantFrom(27, 30, 45),
          async (entries, damage, retentionDays) => {
            const from = await arrange(entries, damage, retentionDays)
            const olderBefore = await reportRows(raw, { before: from })

            const result = await rebuildOn(k, retentionDays, { now: NOW })

            const expected = heldOnly(
              canonicalRollups(recompute(await loggedRollupEvents(raw), pool.lookup, ZONE)),
              from,
            )
            expect([result.heldFrom, result.heldTo]).toEqual([from, storeDay(NOW)])
            expect(heldOnly(await storedRollups(raw), from)).toEqual(expected)
            expect(await reportRows(raw, { before: from })).toEqual(olderBefore)
          },
        ),
        { numRuns },
      )
    }, 240_000)

    it(`AC-2: property: a second rebuild straight after the first reports 0 added, 0 changed and 0 removed in every table and leaves every table as it was, members' created_at included (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(logArb(pool), damageArb, async (entries, damage) => {
          await arrange(entries, damage, 30)
          const first = await rebuildOn(k, 30, { now: NOW })
          const afterFirst = await reportRows(raw)

          const second = await rebuildOn(k, 30, { now: new Date(NOW.getTime() + 60_000) })

          expect(
            countsOf(second).map(({ name, added, changed, removed }) => [
              name,
              added,
              changed,
              removed,
            ]),
          ).toEqual([...ROLLUP_TABLES].sort().map((name) => [name, 0, 0, 0]))
          expect(countsOf(second).map((t) => t.rows)).toEqual(countsOf(first).map((t) => t.rows))
          expect(await reportRows(raw)).toEqual(afterFirst)
        }),
        { numRuns: Math.max(3, Math.ceil(numRuns / 2)) },
      )
    }, 240_000)

    it(`AC-4: property: an event logged and not yet delivered, or dead, when the rebuild runs is in the rebuilt figures, and delivering it afterwards (after retryDead for a dead one) changes nothing (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          quietEventArb(pool),
          fc.constantFrom('undelivered' as const, 'dead' as const),
          async (event, state) => {
            await resetReports(k)
            // An old delivered event, so the floor is the retention bound and the event's day is held.
            const anchor = events.searched('anchor term', new Date(NOW.getTime() - 50 * DAY_MS))
            await logEvents(k, [
              { event: anchor, state: 'delivered' },
              { event, state },
            ])
            const from = expectedHeldFrom(NOW, 30, await oldestCreatedAt(raw))!

            await rebuildOn(k, 30, { now: NOW })

            const expected = heldOnly(
              canonicalRollups(recompute(await loggedRollupEvents(raw), pool.lookup, ZONE)),
              from,
            )
            expect(heldOnly(await storedRollups(raw), from)).toEqual(expected)
            const afterRebuild = await reportRows(raw)

            if (state === 'dead') {
              const retried = await k.store.transaction((tx) =>
                k.repos.eventLog.retryDead(
                  tx,
                  { id: event.id },
                  { floor: new Date(NOW.getTime() - 30 * DAY_MS), limit: 10 },
                ),
              )
              expect(retried.map((r) => r.event.id)).toEqual([event.id])
            }
            await k.app.relay.drain()

            const [row] = await eventRows(raw, 'id = ?', [event.id])
            expect(row?.deliveredAt ?? null, 'the relay delivered it').not.toBeNull()
            expect(await reportRows(raw)).toEqual(afterRebuild)
          },
        ),
        { numRuns: Math.max(4, Math.ceil(numRuns / 2)) },
      )
    }, 240_000)
  })
}
