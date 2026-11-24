import fc from 'fast-check'
import { sql, type SQL } from 'drizzle-orm'
import type {
  NymbalEvent,
  Order,
  OrderPlacedV1Payload,
  OrderDeletedV1Payload,
} from '@nymbalhq/types'
import { postgresDb, sqliteDb, type Tx } from '../../src/db/command-store.js'
import { ROLLUP_EVENT_TYPES } from '../../src/reports/fold.js'
import type { Kernel } from './kernel.js'
import { eventRows } from './outbox.js'
import { writeRaw, type RawReader } from './raw.js'
import {
  ROLLUP_TABLES,
  ZONE,
  addDays,
  clearReports,
  deliver,
  noonOf,
  seedOrder,
  storeDay,
  type Pool,
  type RollupTables,
} from './report-rollups.js'
import { unaudited } from './write-audit.js'

// What the report-rebuild tests share: a log written as a store would have written it (each event appended, then its
// `created_at` set to when it was appended, then delivered, left undelivered or dead), damage to the report tables, the
// first held day worked out apart from the code under test, and the report tables read whole (members' `created_at`
// included) for before-and-after comparisons.

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** A clock for the tests that pass one: the UK clock change of 2026-10-25 falls inside its held days. */
export const NOW = new Date('2026-11-22T12:00:00.000Z')

export const REPORT_HANDLER = 'report-rollups'

/** The kernel's relay never drains on its own timer, so an event left undelivered stays so until a test drains. */
export const QUIET_RELAY = { relay: { intervalMs: 3_600_000 } } as const

export type LogState = 'delivered' | 'undelivered' | 'dead'

export interface LogEntry {
  event: NymbalEvent<unknown>
  state: LogState
  /** The handler was handed it before (a live delivery), whatever the log row says. */
  live?: boolean
  /** When it was appended; its timestamp when absent. */
  createdAt?: Date
}

async function exec(tx: Tx, query: SQL): Promise<void> {
  if (tx.kind === 'sqlite') sqliteDb(tx).run(query)
  else await postgresDb(tx).execute(query)
}

/** Appends the entries, sets each row's `created_at` and state, then makes the live deliveries. */
export async function logEvents(
  k: Pick<Kernel, 'store' | 'repos' | 'eventBus'>,
  entries: readonly LogEntry[],
): Promise<void> {
  if (entries.length === 0) return
  await unaudited(() =>
    k.store.transaction(async (tx) => {
      await k.repos.eventLog.append(
        tx,
        entries.map((e) => e.event),
      )
      for (const e of entries) {
        const appended = e.createdAt ?? new Date(e.event.timestamp)
        await exec(
          tx,
          sql`UPDATE events SET created_at = ${appended.toISOString()} WHERE id = ${e.event.id}`,
        )
        if (e.state === 'delivered') {
          await k.repos.eventLog.markDelivered(
            tx,
            [e.event.id],
            new Date(appended.getTime() + 1_000),
          )
        }
        if (e.state === 'dead') await k.repos.eventLog.recordFailure(tx, e.event.id, appended, 1)
      }
    }),
  )
  for (const e of entries) if (e.live === true) await deliver(k, e.event)
}

/** The report tables, the rollup events of the log and the report handler's records, gone: one kernel, many runs. */
export async function resetReports(k: Pick<Kernel, 'app' | 'dialect' | 'target'>): Promise<void> {
  await clearReports(k)
  const types = ROLLUP_EVENT_TYPES.map(() => '?').join(', ')
  await writeRaw(k.dialect, k.target, `DELETE FROM events WHERE type IN (${types})`, [
    ...ROLLUP_EVENT_TYPES,
  ])
  await writeRaw(k.dialect, k.target, 'DELETE FROM processed_events WHERE handler_name = ?', [
    REPORT_HANDLER,
  ])
}

const asDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date(value as string | number)

/** The oldest `created_at` in the log, as a second connection reads it. */
export async function oldestCreatedAt(raw: RawReader): Promise<Date | null> {
  const [row] = await raw.rows<{ oldest: unknown }>('SELECT min(created_at) AS oldest FROM events')
  return row?.oldest == null ? null : asDate(row.oldest)
}

/**
 * The first store day the log holds whole, worked out apart from the code under test: the day after the store day of
 * the later of `now − retentionDays + 1 h` and the oldest `created_at`.
 */
export function expectedHeldFrom(
  now: Date,
  retentionDays: number,
  oldest: Date | null,
): string | null {
  if (oldest === null) return null
  const retry = now.getTime() - retentionDays * DAY_MS + HOUR_MS
  return addDays(storeDay(new Date(Math.max(retry, oldest.getTime()))), 1)
}

/** The rollup events of the log, as logged. */
export async function loggedRollupEvents(raw: RawReader): Promise<NymbalEvent<unknown>[]> {
  const types: readonly string[] = ROLLUP_EVENT_TYPES
  return (await eventRows(raw)).filter((row) => types.includes(row.type)).map((row) => row.envelope)
}

/** Only the rows of `tables` on `from` or later. */
export function heldOnly(tables: RollupTables, from: string): RollupTables {
  const out = {} as RollupTables
  for (const [name, rows] of Object.entries(tables) as Array<
    [keyof RollupTables, RollupTables[keyof RollupTables]]
  >) {
    out[name] = rows.filter((row) => (row['localDay'] as string) >= from)
  }
  return out
}

const COUNTERS = new Set([
  'captured_minor',
  'refunded_minor',
  'paid_orders',
  'viewers',
  'carts_with_items',
  'checkouts_started',
  'payments_failed',
  'units',
  'line_subtotal_minor',
  'searches',
])
const INSTANTS = new Set(['hour_start', 'created_at'])

function normalised(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [col, value] of Object.entries(row)) {
    if (COUNTERS.has(col)) out[col] = Number(value)
    else if (INSTANTS.has(col) && value != null) out[col] = asDate(value).toISOString()
    else out[col] = value
  }
  return out
}

/** Every row of every report table, members' `created_at` included; `before` keeps only the days before it. */
export async function reportRows(
  raw: RawReader,
  scope: { before?: string } = {},
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {}
  for (const table of ROLLUP_TABLES) {
    const where = scope.before === undefined ? '' : ' WHERE local_day < ?'
    const rows = await raw.rows<Record<string, unknown>>(
      `SELECT * FROM ${table}${where}`,
      scope.before === undefined ? [] : [scope.before],
    )
    out[table] = rows
      .map(normalised)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  return out
}

export async function processedCount(raw: RawReader): Promise<number> {
  return raw.count('processed_events', 'handler_name = ?', [REPORT_HANDLER])
}

/** One day's captured, refunded and paid orders, summed over its hours. */
export async function salesOf(raw: RawReader, day: string): Promise<[number, number, number]> {
  const [row] = await raw.rows<{ captured: unknown; refunded: unknown; paid: unknown }>(
    `SELECT COALESCE(SUM(captured_minor), 0) AS captured, COALESCE(SUM(refunded_minor), 0) AS refunded,
            COALESCE(SUM(paid_orders), 0) AS paid
     FROM report_sales_hours WHERE local_day = ?`,
    [day],
  )
  return [Number(row!.captured), Number(row!.refunded), Number(row!.paid)]
}

/** Damage to the report tables, relative to the first held day. */
export interface Damage {
  /** A table whose rows of one held day are deleted. */
  dropTable: (typeof ROLLUP_TABLES)[number] | null
  dropDay: number
  /** Every figure of the held days doubled. */
  double: boolean
  /** Rows on held days no event explains. */
  stale: boolean
  /** Rows on days before the first held day that the log no longer explains. */
  older: boolean
}

export const damageArb: fc.Arbitrary<Damage> = fc.record({
  dropTable: fc.constantFrom(null, ...ROLLUP_TABLES),
  dropDay: fc.integer({ min: 0, max: 8 }),
  double: fc.boolean(),
  stale: fc.boolean(),
  older: fc.boolean(),
})

let damageTag = 0

export async function damageReports(
  k: Pick<Kernel, 'store'>,
  damage: Damage,
  heldFrom: string,
  at: Date,
): Promise<void> {
  damageTag += 1
  const tag = `damage-${damageTag}`
  const salesRow = (day: string, captured: number) =>
    sql`INSERT INTO report_sales_hours (hour_start, local_day, timezone, currency, source, captured_minor, refunded_minor, paid_orders)
        VALUES (${noonOf(day).toISOString()}, ${day}, ${ZONE}, 'USD', ${`storefront`}, ${captured}, 0, 1)`
  const searchRow = (day: string, searches: number) =>
    sql`INSERT INTO report_search_days (local_day, term, timezone, searches) VALUES (${day}, ${`${tag}-${day}`}, ${ZONE}, ${searches})`
  const memberRow = (day: string) =>
    sql`INSERT INTO report_members (kind, local_day, member, created_at) VALUES ('viewer', ${day}, ${`${tag}-${day}`}, ${at.toISOString()})`

  await unaudited(() =>
    k.store.transaction(async (tx) => {
      if (damage.dropTable !== null) {
        await exec(
          tx,
          sql`DELETE FROM ${sql.raw(damage.dropTable)} WHERE local_day = ${addDays(heldFrom, damage.dropDay)}`,
        )
      }
      if (damage.double) {
        await exec(
          tx,
          sql`UPDATE report_sales_hours SET captured_minor = captured_minor * 2, refunded_minor = refunded_minor * 2, paid_orders = paid_orders * 2 WHERE local_day >= ${heldFrom}`,
        )
        await exec(
          tx,
          sql`UPDATE report_funnel_days SET viewers = viewers * 2, carts_with_items = carts_with_items * 2, checkouts_started = checkouts_started * 2, payments_failed = payments_failed * 2 WHERE local_day >= ${heldFrom}`,
        )
        await exec(
          tx,
          sql`UPDATE report_product_days SET units = units * 2, line_subtotal_minor = line_subtotal_minor * 2 WHERE local_day >= ${heldFrom}`,
        )
        await exec(
          tx,
          sql`UPDATE report_search_days SET searches = searches * 2 WHERE local_day >= ${heldFrom}`,
        )
      }
      if (damage.stale) {
        await exec(tx, salesRow(addDays(heldFrom, 1), 999))
        await exec(tx, searchRow(addDays(heldFrom, 2), 3))
        await exec(tx, memberRow(addDays(heldFrom, 2)))
      }
      if (damage.older) {
        await exec(tx, salesRow(addDays(heldFrom, -2), 4_321))
        await exec(tx, searchRow(addDays(heldFrom, -1), 2))
        await exec(tx, searchRow(addDays(heldFrom, -6), 5))
        await exec(tx, memberRow(addDays(heldFrom, -1)))
      }
    }),
  )
}

/** An import's events land on the order's `createdAt`; a store emits them no earlier than that. */
export function noEarlierThanItsOrder(event: NymbalEvent<unknown>): NymbalEvent<unknown> {
  let createdAt: string | Date | undefined
  if (event.type === 'order.placed.v1') {
    const { order } = event.payload as OrderPlacedV1Payload
    if (order.source === 'import') createdAt = order.createdAt
  }
  if (event.type === 'order.deleted.v1') {
    const p = event.payload as OrderDeletedV1Payload
    if (p.source === 'import') createdAt = p.createdAt
  }
  if (createdAt === undefined) return event
  const floor = new Date(createdAt).getTime()
  return Date.parse(event.timestamp) >= floor
    ? event
    : { ...event, timestamp: new Date(floor).toISOString() }
}

/** The pool with imported orders whose history lies on a held day and on a day before the held days. */
export async function withImports(k: Parameters<typeof seedOrder>[0], pool: Pool): Promise<Pool> {
  const imports: Order[] = []
  for (const createdAt of ['2026-10-28T09:00:00.000Z', '2026-10-21T09:00:00.000Z']) {
    imports.push(
      await seedOrder(k, {
        source: 'import',
        createdAt: new Date(createdAt),
        capturedMinor: 2_400,
        refundedMinor: 300,
      }),
    )
  }
  const orders = [...pool.orders, ...imports]
  const byId = new Map(orders.map((o) => [o.id, o]))
  return {
    orders,
    cartTokens: pool.cartTokens,
    lookup: { orderOf: (id) => byId.get(id) ?? null, cartSourceOf: pool.lookup.cartSourceOf },
  }
}

/** When an event was appended: a little after its timestamp. */
export function appendedAfter(event: NymbalEvent<unknown>, lagMs: number): Date {
  return new Date(Date.parse(event.timestamp) + lagMs)
}
