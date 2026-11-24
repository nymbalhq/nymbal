import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Order } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, writeRaw, type RawReader } from '../support/raw.js'
import {
  NOW,
  QUIET_RELAY,
  expectedHeldFrom,
  logEvents,
  oldestCreatedAt,
  processedCount,
  reportRows,
  salesOf,
} from '../support/report-rebuild.js'
import { countsOf, rebuildOn } from '../support/report-rebuild-run.js'
import {
  addDays,
  deliver,
  events,
  noonOf,
  seedOrder,
  seedPool,
  storeDay,
  type Pool,
  type ReportBody,
} from '../support/report-rollups.js'

// The rebuild on SQLite, case by case: an import's history on and off the held days, a backfill the report route then
// answers, and a dry run that counts what the run will change and writes nothing.

const DAY_MS = 24 * 60 * 60_000

describe('the rebuild with a fixed clock', () => {
  let k: Kernel
  let raw: RawReader
  let pool: Pool
  let heldFrom: string

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite', appOptions: QUIET_RELAY })
    raw = openRaw(k.dialect, k.target)
    pool = await seedPool(k)
    await k.app.relay.drain()
    // An old delivered event, so the floor is the retention bound: held days start 2026-10-24.
    await logEvents(k, [
      {
        event: events.searched('anchor term', new Date(NOW.getTime() - 50 * DAY_MS)),
        state: 'delivered',
      },
    ])
    heldFrom = expectedHeldFrom(NOW, 30, await oldestCreatedAt(raw))!
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await k?.close()
  })

  const imported = (createdAt: string): Promise<Order> =>
    seedOrder(k, {
      source: 'import',
      createdAt: new Date(createdAt),
      capturedMinor: 3_000,
      refundedMinor: 500,
    })

  const unitsOf = async (day: string): Promise<number> => {
    const [row] = await raw.rows<{ units: unknown }>(
      'SELECT COALESCE(SUM(units), 0) AS units FROM report_product_days WHERE local_day = ?',
      [day],
    )
    return Number(row!.units)
  }

  /** Every report row of one day, as a second connection reads it. */
  const rowsOfDay = async (day: string) => {
    const all = await reportRows(raw)
    return Object.fromEntries(
      Object.entries(all).map(([table, rows]) => [
        table,
        rows.filter((r) => r['local_day'] === day),
      ]),
    )
  }

  describe('AC-6: an import’s history', () => {
    it('AC-6: a logged import whose order was created on a held day counts on that day after a rebuild, once', async () => {
      const day = '2026-11-02'
      expect(day >= heldFrom).toBe(true)
      const order = await imported(`${day}T10:00:00.000Z`)
      await logEvents(k, [
        { event: events.placed(order, noonOf('2026-11-10')), state: 'delivered' },
      ])

      await rebuildOn(k, 30, { now: NOW })
      await rebuildOn(k, 30, { now: NOW })

      expect(await salesOf(raw, day)).toEqual([order.capturedMinor, order.refundedMinor, 1])
      expect(await unitsOf(day)).toBe(order.lineItems.reduce((n, l) => n + l.qty, 0))
    })

    it('AC-6: an import whose order was created before the held days leaves that day’s rows exactly as they were, whether live delivery counted it or not', async () => {
      const counted = await imported('2026-08-01T10:00:00.000Z')
      const uncounted = await imported('2026-08-02T10:00:00.000Z')
      await logEvents(k, [
        { event: events.placed(counted, noonOf('2026-11-11')), state: 'delivered', live: true },
        { event: events.placed(uncounted, noonOf('2026-11-11')), state: 'delivered' },
      ])
      expect(await salesOf(raw, '2026-08-01'), 'live delivery counted it').toEqual([
        counted.capturedMinor,
        counted.refundedMinor,
        1,
      ])
      const before = [await rowsOfDay('2026-08-01'), await rowsOfDay('2026-08-02')]

      await rebuildOn(k, 30, { now: NOW })

      expect([await rowsOfDay('2026-08-01'), await rowsOfDay('2026-08-02')]).toEqual(before)
    })

    it('AC-6: an import logged and not yet claimed when the rebuild runs, its order created before the held days, adds its figures once to its own day when delivered afterwards', async () => {
      const day = '2026-08-03'
      const order = await imported(`${day}T10:00:00.000Z`)
      const placed = events.placed(order, noonOf('2026-11-12'))
      await logEvents(k, [{ event: placed, state: 'undelivered' }])

      await rebuildOn(k, 30, { now: NOW })
      const afterRebuild = await salesOf(raw, day)
      await k.app.relay.drain()
      const [row] = await eventRows(raw, 'id = ?', [placed.id])
      expect(row?.deliveredAt ?? null, 'the relay delivered it').not.toBeNull()
      const afterDelivery = await salesOf(raw, day)
      await deliver(k, placed)

      expect(afterRebuild).toEqual([0, 0, 0])
      expect(afterDelivery).toEqual([order.capturedMinor, order.refundedMinor, 1])
      expect(await salesOf(raw, day)).toEqual(afterDelivery)
    })
  })

  describe('AC-8: a dry run', () => {
    it('AC-8: a dry run answers the same table counts the run then reports, and writes no report row, no member and no processed record', async () => {
      const gbp = pool.orders.find((o) => o.currency === 'GBP' && o.source === 'storefront')!
      await logEvents(k, [
        {
          event: events.captured(gbp, 1_200, noonOf('2026-11-13')),
          state: 'delivered',
          live: true,
        },
        { event: events.viewed('dry-viewer', noonOf('2026-11-13')), state: 'undelivered' },
        { event: events.searched('dry term', noonOf('2026-11-14')), state: 'dead' },
        { event: events.captured(gbp, 800, noonOf('2026-11-14')), state: 'delivered' },
      ])
      await writeRaw(k.dialect, k.target, 'DELETE FROM report_sales_hours WHERE local_day = ?', [
        '2026-11-13',
      ])
      await writeRaw(
        k.dialect,
        k.target,
        'INSERT INTO report_search_days (local_day, term, timezone, searches) VALUES (?, ?, ?, ?)',
        ['2026-11-15', 'no event says so', 'Europe/London', 4],
      )
      const rowsBefore = await reportRows(raw)
      const claimsBefore = await processedCount(raw)

      const dry = await rebuildOn(k, 30, { now: NOW, dryRun: true })

      expect(await reportRows(raw)).toEqual(rowsBefore)
      expect(await processedCount(raw)).toBe(claimsBefore)

      const run = await rebuildOn(k, 30, { now: NOW })

      expect(countsOf(dry)).toEqual(countsOf(run))
      const changes = countsOf(run).reduce((n, t) => n + t.added + t.changed + t.removed, 0)
      expect(changes, 'the damage is something a run changes').toBeGreaterThanOrEqual(3)
      expect(await processedCount(raw)).toBeGreaterThan(claimsBefore)
    })
  })
})

describe('AC-7: a backfill the report route answers', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader
  let admin: AdminClient
  let pool: Pool

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite', appOptions: QUIET_RELAY })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
    admin = await adminClient(k, served.baseUrl)
    pool = await seedPool(k)
    await k.app.relay.drain()
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  async function report(): Promise<ReportBody> {
    const res = await admin.call<ReportBody>('GET', '/api/admin/reports')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.data!
  }

  const capturedOf = (body: ReportBody, currency: string): number =>
    body.money.totals.find((t) => t.currency === currency)?.capturedMinor ?? 0

  it('AC-7: on a store whose log holds delivered events the report handler never saw, a rebuild makes the report answer those days’ figures and a since of the first held day with a figure', async () => {
    const today = storeDay(new Date())
    const gbp = pool.orders.find((o) => o.currency === 'GBP' && o.source === 'storefront')!
    const eur = pool.orders.find((o) => o.currency === 'EUR' && o.source === 'storefront')!
    // The oldest append: its day is the log's first, partial day, so the held days start the day after.
    const partial = events.captured(gbp, 4_000, noonOf(addDays(today, -6)))
    const held = [
      events.captured(gbp, 1_000, noonOf(addDays(today, -5))),
      events.captured(gbp, 2_500, noonOf(addDays(today, -3))),
      events.captured(eur, 700, noonOf(addDays(today, -3))),
    ]
    await logEvents(
      k,
      [partial, ...held].map((event) => ({ event, state: 'delivered' as const })),
    )
    const before = await report()
    expect([before.since, capturedOf(before, 'GBP')], 'nothing counted them').toEqual([null, 0])

    await rebuildOn(k, 30)

    const after = await report()
    expect(after.since).toBe(addDays(today, -5))
    expect(capturedOf(after, 'GBP')).toBe(1_000 + 2_500)
    expect(capturedOf(after, 'EUR')).toBe(700)
  })
})
