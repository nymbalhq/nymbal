import type { NymbalEvent, Order } from '@nymbalhq/types'
import type { CommandStore, ReadTx, Tx } from '../db/command-store.js'
import { retryFloor } from '../repositories/event-log.js'
import type { Repositories } from '../repositories/index.js'
import {
  foldEvent,
  rollupAccumulator,
  ROLLUP_EVENT_TYPES,
  type RollupLookup,
  type RollupRows,
} from './fold.js'
import { addDays, localDayOf } from './time.js'

// Rebuilding the report tables from the event log: the days the log still holds whole are replaced by a fold of it,
// older days are left as live delivery made them.

const HANDLER = 'report-rollups'
const HOUR_MS = 60 * 60_000
const PAGE = 1_000

/**
 * The first store day the log still holds whole, or null: the day after the store day of the later of
 * `retryFloor(now, retentionDays)` and the oldest logged event's `created_at`; null for an empty log.
 */
export function heldFrom(
  now: Date,
  retentionDays: number,
  oldestCreatedAt: Date | null,
  timeZone: string,
): string | null {
  if (oldestCreatedAt === null) return null
  const floor = Math.max(retryFloor(now, retentionDays).getTime(), oldestCreatedAt.getTime())
  return addDays(localDayOf(new Date(floor), timeZone), 1)
}

export type ReportTableName =
  | 'report_sales_hours'
  | 'report_funnel_days'
  | 'report_product_days'
  | 'report_search_days'
  | 'report_members'

export interface ReportTableRebuild {
  name: ReportTableName
  /** Rows the held days hold after the rebuild (or would, in a dry run). */
  rows: number
  added: number
  changed: number
  removed: number
}

export interface ReportRebuild {
  /** Null: the log holds no whole day, and nothing was rebuilt. */
  heldFrom: string | null
  /** Today's store day; null when nothing was rebuilt. */
  heldTo: string | null
  /** Distinct events folded. */
  events: number
  tables: ReportTableRebuild[]
  ms: number
}

export interface RebuildReportsDeps {
  store: CommandStore
  repos: Pick<Repositories, 'eventLog' | 'processedEvent' | 'reportRollup' | 'order' | 'cart'>
  timeZone: string
  retentionDays: number
}

type Keyed = { [K in keyof RollupRows]: (row: RollupRows[K][number]) => string }

const KEYS: Keyed = {
  salesHours: (r) => `${r.hourStart.toISOString()}|${r.currency}|${r.source}`,
  funnelDays: (r) => `${r.localDay}|${r.source}`,
  productDays: (r) => `${r.localDay}|${r.variantId}|${r.currency}|${r.source}`,
  searchDays: (r) => `${r.localDay}|${r.term}`,
  members: (r) => `${r.kind}|${r.localDay}|${r.member}`,
}

const TABLES: Array<[keyof RollupRows, ReportTableName]> = [
  ['salesHours', 'report_sales_hours'],
  ['funnelDays', 'report_funnel_days'],
  ['productDays', 'report_product_days'],
  ['searchDays', 'report_search_days'],
  ['members', 'report_members'],
]

/** Every figure of a row: a row netted to zero says nothing the absence of a row does not, as live delivery has it. */
const COUNTERS: { [K in keyof RollupRows]: Array<keyof RollupRows[K][number]> } = {
  salesHours: ['capturedMinor', 'refundedMinor', 'paidOrders'],
  funnelDays: ['viewers', 'cartsWithItems', 'checkoutsStarted', 'paymentsFailed'],
  productDays: ['units', 'lineSubtotalMinor'],
  searchDays: ['searches'],
  members: [],
}

function withoutZeroRows(rows: RollupRows): RollupRows {
  const keep = <K extends keyof RollupRows>(table: K): RollupRows[K] => {
    const counters = COUNTERS[table] as string[]
    if (counters.length === 0) return rows[table]
    return (rows[table] as Array<Record<string, unknown>>).filter((row) =>
      counters.some((c) => row[c] !== 0),
    ) as RollupRows[K]
  }
  return {
    salesHours: keep('salesHours'),
    funnelDays: keep('funnelDays'),
    productDays: keep('productDays'),
    searchDays: keep('searchDays'),
    members: keep('members'),
  }
}

/** A row as a string, its fields in one order whichever order they were built in. */
function comparable(row: object): string {
  return JSON.stringify(row, Object.keys(row).sort())
}

function diff(stored: RollupRows, next: RollupRows): ReportTableRebuild[] {
  return TABLES.map(([table, name]) => {
    const key = KEYS[table] as (row: unknown) => string
    const before = new Map((stored[table] as object[]).map((r) => [key(r), comparable(r)]))
    const after = new Map((next[table] as object[]).map((r) => [key(r), comparable(r)]))
    let added = 0
    let changed = 0
    for (const [k, row] of after) {
      const was = before.get(k)
      if (was === undefined) added += 1
      else if (was !== row) changed += 1
    }
    let removed = 0
    for (const k of before.keys()) if (!after.has(k)) removed += 1
    return { name, rows: after.size, added, changed, removed }
  })
}

/** The orders and carts one page of events names, read once so the fold stays synchronous and pure. */
async function lookupFor(
  tx: ReadTx,
  repos: RebuildReportsDeps['repos'],
  events: readonly NymbalEvent<unknown>[],
): Promise<RollupLookup> {
  const orders = new Map<string, Order | null>()
  const carts = new Map<string, string | null>()
  for (const event of events) {
    const { orderId, cartId } = event.payload as { orderId?: string; cartId?: string }
    if (orderId && !orders.has(orderId))
      orders.set(orderId, await repos.order.findById(tx, orderId))
    if (cartId && !carts.has(cartId)) {
      carts.set(cartId, (await repos.cart.findByToken(tx, cartId))?.source ?? null)
    }
  }
  return {
    orderOf: (id) => orders.get(id) ?? null,
    cartSourceOf: (token) => carts.get(token) ?? null,
  }
}

/**
 * Replaces the report rows of the days the log still holds whole with a fold of the log, in one write transaction,
 * and records every event it counted as processed so a later delivery adds nothing. An event whose figures land on an
 * older day (an import's history) is left out and left unrecorded: its delivery counts it there, as it would have.
 * A dry run counts what would change and writes nothing.
 */
export async function rebuildReports(
  deps: RebuildReportsDeps,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<ReportRebuild> {
  const { store, repos, timeZone, retentionDays } = deps
  const now = options.now ?? new Date()
  const dryRun = options.dryRun === true
  const started = Date.now()

  const work = async (tx: ReadTx, write: Tx | null): Promise<ReportRebuild> => {
    if (write !== null) await repos.reportRollup.holdForRebuild(write)
    const oldest = await repos.eventLog.oldestCreatedAt(tx)
    const from = heldFrom(now, retentionDays, oldest, timeZone)
    if (from === null || oldest === null) {
      return {
        heldFrom: null,
        heldTo: null,
        events: 0,
        tables: TABLES.map(([, name]) => ({ name, rows: 0, added: 0, changed: 0, removed: 0 })),
        ms: Date.now() - started,
      }
    }
    const floor = Math.max(retryFloor(now, retentionDays).getTime(), oldest.getTime())
    // From an hour before the floor: a product view's stamp can run ahead of its append.
    const since = new Date(floor - HOUR_MS)

    const rows = rollupAccumulator()
    const counted: string[] = []
    let seq = 0
    for (;;) {
      const page = await repos.eventLog.listAfter(tx, seq, {
        types: [...ROLLUP_EVENT_TYPES],
        since,
        limit: PAGE,
      })
      if (page.length === 0) break
      seq = page[page.length - 1]!.seq
      const events = page.map((logged) => logged.event)
      const lookup = await lookupFor(tx, repos, events)
      for (const event of events) {
        const deltas = foldEvent(event, lookup, timeZone)
        // An event's deltas share one day, so an event is kept or dropped whole.
        if (deltas.some((d) => d.localDay < from)) continue
        rows.add(event.id, deltas)
        counted.push(event.id)
      }
    }

    const next = withoutZeroRows(rows.rows())
    const tables = diff(await repos.reportRollup.rowsFrom(tx, from), next)
    if (write !== null) {
      await repos.reportRollup.replaceFrom(write, from, next, now)
      for (const id of counted) await repos.processedEvent.markProcessed(write, HANDLER, id, now)
    }
    return {
      heldFrom: from,
      heldTo: localDayOf(now, timeZone),
      events: counted.length,
      tables,
      ms: Date.now() - started,
    }
  }

  if (dryRun) return store.read((tx) => work(tx, null))
  return store.transaction((tx) => work(tx, tx))
}
