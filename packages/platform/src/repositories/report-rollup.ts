import { sql, type SQL } from 'drizzle-orm'
import type { ReportFunnelCounts } from '@nymbalhq/types'
import {
  postgresDb,
  sqliteDb,
  type CommandStore,
  type ReadTx,
  type StoreRepository,
  type Tx,
} from '../db/command-store.js'
import type { RollupDelta, RollupMember, RollupRows } from '../reports/fold.js'

export interface SalesTotalRow {
  currency: string
  source: string
  capturedMinor: number
  refundedMinor: number
  paidOrders: number
}

export interface SalesHourReadRow extends SalesTotalRow {
  hourStart: Date
  localDay: string
  timezone: string
}

export interface FunnelTotalRow extends ReportFunnelCounts {
  source: string
}

export interface FunnelDayReadRow extends FunnelTotalRow {
  localDay: string
  timezone: string
}

export interface ProductTotalRow {
  productId: string
  productName: string
  currency: string
  source: string
  units: number
  lineSubtotalMinor: number
}

export interface UnitsSoldRow {
  variantId: string
  productId: string
  productName: string
  sku: string
  unitsSold: number
  stock: number
}

export interface SearchTermRow {
  term: string
  searches: number
}

/** The report tables: figures folded from events by delivery, and the reads the report is built from. */
export interface ReportRollupRepository extends StoreRepository {
  /** Applies one delta by conditional upsert; a distinct counter moves only when its member is new. */
  apply(tx: Tx, delta: RollupDelta, at: Date): Promise<void>
  /**
   * Shuts deliveries out until the transaction ends, so a delivery cannot commit between a rebuild's read of the log
   * and its replace. Postgres only: on SQLite every write transaction already runs alone.
   */
  holdForRebuild(tx: Tx): Promise<void>
  /** A delivery's share of the same lock, taken before its claim: deliveries run side by side, never inside a rebuild. */
  holdForDelivery(tx: Tx): Promise<void>
  /** Every row and member of `fromDay` and later. */
  rowsFrom(tx: ReadTx, fromDay: string): Promise<RollupRows>
  /**
   * Replaces the rows and members of `fromDay` and later with `rows`. A member already stored keeps its `created_at`,
   * since retention deletes members by it; a new one gets `at`.
   */
  replaceFrom(tx: Tx, fromDay: string, rows: RollupRows, at: Date): Promise<void>
  /** Deletes the day-scoped digests written before `at`, with the event log they were deduplicating; no figure goes. */
  deleteMembersBefore(tx: Tx, at: Date): Promise<number>
  /** The earliest day with a row in any figure table, or null when there is none. */
  since(tx: ReadTx): Promise<string | null>
  /** As `since`, leaving out sales and product rows an import wrote: the first day the store took figures itself. */
  liveSince(tx: ReadTx): Promise<string | null>
  salesTotals(tx: ReadTx, from: string, to: string): Promise<SalesTotalRow[]>
  salesHours(tx: ReadTx, from: string, to: string): Promise<SalesHourReadRow[]>
  funnelTotals(tx: ReadTx, from: string, to: string): Promise<FunnelTotalRow[]>
  funnelDays(tx: ReadTx, from: string, to: string): Promise<FunnelDayReadRow[]>
  productTotals(tx: ReadTx, from: string, to: string): Promise<ProductTotalRow[]>
  /** The variants with units sold over the days, with their stock now; a variant since deleted is left out. */
  unitsSold(tx: ReadTx, from: string, to: string): Promise<UnitsSoldRow[]>
  zeroResultTerms(tx: ReadTx, from: string, to: string, limit: number): Promise<SearchTermRow[]>
  /**
   * The terms searched at least `minSearches` times on `day` and on no day from `quietFrom` to the day before, most
   * searched first, then by term.
   */
  newZeroResultTerms(
    tx: ReadTx,
    day: string,
    quietFrom: string,
    minSearches: number,
  ): Promise<SearchTermRow[]>
}

// Plain SQL for both dialects: the statements here are the same on each, and a parameter given as an ISO string reads
// as the timestamp a Postgres column expects and as the text a SQLite column holds.
async function run(tx: Tx, query: SQL): Promise<number> {
  if (tx.kind === 'sqlite') return sqliteDb(tx).run(query).changes
  return (await postgresDb(tx).execute(query)).rowCount ?? 0
}

async function rows(tx: ReadTx, query: SQL): Promise<Array<Record<string, unknown>>> {
  if (tx.kind === 'sqlite') return sqliteDb(tx).all(query) as Array<Record<string, unknown>>
  return (await postgresDb(tx).execute(query)).rows as Array<Record<string, unknown>>
}

const text = (value: unknown) => String(value)
const num = (value: unknown) => Number(value)

// Outside the int4 range, so it never meets the `hashtext(...)` keys other advisory locks take.
const REBUILD_LOCK_KEY = '7809646233498521600'

// Rows a multi-row insert carries: eleven columns a product row keep a chunk well under SQLite's parameter limit.
const INSERT_CHUNK = 100

async function insertChunked<T>(
  tx: Tx,
  rows: readonly T[],
  into: SQL,
  value: (row: T) => SQL,
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK)
    await run(tx, sql`${into} VALUES ${sql.join(chunk.map(value), sql`, `)}`)
  }
}

const memberKey = (m: RollupMember) => `${m.kind}|${m.localDay}|${m.member}`

export function createReportRollupRepository(store: CommandStore): ReportRollupRepository {
  return {
    store,

    async apply(tx, delta, at) {
      if (delta.table === 'funnelDays' && delta.member !== undefined) {
        const m = delta.member
        const took = await run(
          tx,
          sql`INSERT INTO report_members (kind, local_day, member, created_at)
              VALUES (${m.kind}, ${m.localDay}, ${m.member}, ${at.toISOString()})
              ON CONFLICT DO NOTHING`,
        )
        if (took === 0) return
      }
      switch (delta.table) {
        case 'salesHours':
          await run(
            tx,
            sql`INSERT INTO report_sales_hours
                  (hour_start, local_day, timezone, currency, source, captured_minor, refunded_minor, paid_orders)
                VALUES (${delta.hourStart.toISOString()}, ${delta.localDay}, ${delta.timezone}, ${delta.currency},
                        ${delta.source}, ${delta.capturedMinor}, ${delta.refundedMinor}, ${delta.paidOrders})
                ON CONFLICT (hour_start, currency, source) DO UPDATE SET
                  captured_minor = report_sales_hours.captured_minor + excluded.captured_minor,
                  refunded_minor = report_sales_hours.refunded_minor + excluded.refunded_minor,
                  paid_orders = report_sales_hours.paid_orders + excluded.paid_orders`,
          )
          // A figure taken back leaves no row behind it: an import removed in full leaves the tables as they were.
          if (delta.capturedMinor < 0 || delta.refundedMinor < 0 || delta.paidOrders < 0) {
            await run(
              tx,
              sql`DELETE FROM report_sales_hours
                  WHERE hour_start = ${delta.hourStart.toISOString()} AND currency = ${delta.currency}
                    AND source = ${delta.source} AND captured_minor = 0 AND refunded_minor = 0 AND paid_orders = 0`,
            )
          }
          return
        case 'funnelDays':
          await run(
            tx,
            sql`INSERT INTO report_funnel_days
                  (local_day, source, timezone, viewers, carts_with_items, checkouts_started, payments_failed)
                VALUES (${delta.localDay}, ${delta.source}, ${delta.timezone}, ${delta.viewers},
                        ${delta.cartsWithItems}, ${delta.checkoutsStarted}, ${delta.paymentsFailed})
                ON CONFLICT (local_day, source) DO UPDATE SET
                  viewers = report_funnel_days.viewers + excluded.viewers,
                  carts_with_items = report_funnel_days.carts_with_items + excluded.carts_with_items,
                  checkouts_started = report_funnel_days.checkouts_started + excluded.checkouts_started,
                  payments_failed = report_funnel_days.payments_failed + excluded.payments_failed`,
          )
          return
        case 'productDays':
          await run(
            tx,
            sql`INSERT INTO report_product_days
                  (local_day, variant_id, currency, source, timezone, product_id, product_name, variant_name, sku,
                   units, line_subtotal_minor)
                VALUES (${delta.localDay}, ${delta.variantId}, ${delta.currency}, ${delta.source}, ${delta.timezone},
                        ${delta.productId}, ${delta.productName}, ${delta.variantName}, ${delta.sku},
                        ${delta.units}, ${delta.lineSubtotalMinor})
                ON CONFLICT (local_day, variant_id, currency, source) DO UPDATE SET
                  units = report_product_days.units + excluded.units,
                  line_subtotal_minor = report_product_days.line_subtotal_minor + excluded.line_subtotal_minor`,
          )
          if (delta.units < 0) {
            await run(
              tx,
              sql`DELETE FROM report_product_days
                  WHERE local_day = ${delta.localDay} AND variant_id = ${delta.variantId}
                    AND currency = ${delta.currency} AND source = ${delta.source}
                    AND units = 0 AND line_subtotal_minor = 0`,
            )
          }
          return
        case 'searchDays':
          await run(
            tx,
            sql`INSERT INTO report_search_days (local_day, term, timezone, searches)
                VALUES (${delta.localDay}, ${delta.term}, ${delta.timezone}, ${delta.searches})
                ON CONFLICT (local_day, term) DO UPDATE SET
                  searches = report_search_days.searches + excluded.searches`,
          )
          return
      }
    },

    async holdForRebuild(tx) {
      if (tx.kind === 'postgres')
        await run(tx, sql`SELECT pg_advisory_xact_lock(${REBUILD_LOCK_KEY}::bigint)`)
    },

    async holdForDelivery(tx) {
      if (tx.kind === 'postgres') {
        await run(tx, sql`SELECT pg_advisory_xact_lock_shared(${REBUILD_LOCK_KEY}::bigint)`)
      }
    },

    async rowsFrom(tx, fromDay) {
      const [sales, funnel, product, search, members] = [
        await rows(
          tx,
          sql`SELECT hour_start, local_day, timezone, currency, source, captured_minor, refunded_minor, paid_orders
              FROM report_sales_hours WHERE local_day >= ${fromDay}`,
        ),
        await rows(
          tx,
          sql`SELECT local_day, source, timezone, viewers, carts_with_items, checkouts_started, payments_failed
              FROM report_funnel_days WHERE local_day >= ${fromDay}`,
        ),
        await rows(
          tx,
          sql`SELECT local_day, variant_id, currency, source, timezone, product_id, product_name, variant_name, sku,
                     units, line_subtotal_minor
              FROM report_product_days WHERE local_day >= ${fromDay}`,
        ),
        await rows(
          tx,
          sql`SELECT local_day, term, timezone, searches FROM report_search_days WHERE local_day >= ${fromDay}`,
        ),
        await rows(
          tx,
          sql`SELECT kind, local_day, member FROM report_members WHERE local_day >= ${fromDay}`,
        ),
      ]
      return {
        salesHours: sales.map((r) => ({
          hourStart: new Date(text(r['hour_start'])),
          localDay: text(r['local_day']),
          timezone: text(r['timezone']),
          currency: text(r['currency']),
          source: text(r['source']),
          capturedMinor: num(r['captured_minor']),
          refundedMinor: num(r['refunded_minor']),
          paidOrders: num(r['paid_orders']),
        })),
        funnelDays: funnel.map((r) => ({
          localDay: text(r['local_day']),
          source: text(r['source']),
          timezone: text(r['timezone']),
          viewers: num(r['viewers']),
          cartsWithItems: num(r['carts_with_items']),
          checkoutsStarted: num(r['checkouts_started']),
          paymentsFailed: num(r['payments_failed']),
        })),
        productDays: product.map((r) => ({
          localDay: text(r['local_day']),
          variantId: text(r['variant_id']),
          currency: text(r['currency']),
          source: text(r['source']),
          timezone: text(r['timezone']),
          productId: text(r['product_id']),
          productName: text(r['product_name']),
          variantName: text(r['variant_name']),
          sku: text(r['sku']),
          units: num(r['units']),
          lineSubtotalMinor: num(r['line_subtotal_minor']),
        })),
        searchDays: search.map((r) => ({
          localDay: text(r['local_day']),
          term: text(r['term']),
          timezone: text(r['timezone']),
          searches: num(r['searches']),
        })),
        members: members.map((r) => ({
          kind: text(r['kind']) as RollupMember['kind'],
          localDay: text(r['local_day']),
          member: text(r['member']),
        })),
      }
    },

    async replaceFrom(tx, fromDay, next, at) {
      const stored = new Map<string, string>()
      for (const r of await rows(
        tx,
        sql`SELECT kind, local_day, member, created_at FROM report_members WHERE local_day >= ${fromDay}`,
      )) {
        const createdAt = r['created_at']
        stored.set(
          `${text(r['kind'])}|${text(r['local_day'])}|${text(r['member'])}`,
          createdAt instanceof Date ? createdAt.toISOString() : text(createdAt),
        )
      }
      for (const table of [
        'report_sales_hours',
        'report_funnel_days',
        'report_product_days',
        'report_search_days',
        'report_members',
      ]) {
        await run(tx, sql`DELETE FROM ${sql.raw(table)} WHERE local_day >= ${fromDay}`)
      }
      await insertChunked(
        tx,
        next.salesHours,
        sql`INSERT INTO report_sales_hours
              (hour_start, local_day, timezone, currency, source, captured_minor, refunded_minor, paid_orders)`,
        (r) =>
          sql`(${r.hourStart.toISOString()}, ${r.localDay}, ${r.timezone}, ${r.currency}, ${r.source},
               ${r.capturedMinor}, ${r.refundedMinor}, ${r.paidOrders})`,
      )
      await insertChunked(
        tx,
        next.funnelDays,
        sql`INSERT INTO report_funnel_days
              (local_day, source, timezone, viewers, carts_with_items, checkouts_started, payments_failed)`,
        (r) =>
          sql`(${r.localDay}, ${r.source}, ${r.timezone}, ${r.viewers}, ${r.cartsWithItems}, ${r.checkoutsStarted},
               ${r.paymentsFailed})`,
      )
      await insertChunked(
        tx,
        next.productDays,
        sql`INSERT INTO report_product_days
              (local_day, variant_id, currency, source, timezone, product_id, product_name, variant_name, sku, units,
               line_subtotal_minor)`,
        (r) =>
          sql`(${r.localDay}, ${r.variantId}, ${r.currency}, ${r.source}, ${r.timezone}, ${r.productId},
               ${r.productName}, ${r.variantName}, ${r.sku}, ${r.units}, ${r.lineSubtotalMinor})`,
      )
      await insertChunked(
        tx,
        next.searchDays,
        sql`INSERT INTO report_search_days (local_day, term, timezone, searches)`,
        (r) => sql`(${r.localDay}, ${r.term}, ${r.timezone}, ${r.searches})`,
      )
      await insertChunked(
        tx,
        next.members,
        sql`INSERT INTO report_members (kind, local_day, member, created_at)`,
        (m) =>
          sql`(${m.kind}, ${m.localDay}, ${m.member}, ${stored.get(memberKey(m)) ?? at.toISOString()})`,
      )
    },

    deleteMembersBefore(tx, at) {
      return run(tx, sql`DELETE FROM report_members WHERE created_at < ${at.toISOString()}`)
    },

    async since(tx) {
      const [row] = await rows(
        tx,
        sql`SELECT MIN(local_day) AS day FROM (
              SELECT local_day FROM report_sales_hours
              UNION ALL SELECT local_day FROM report_funnel_days
              UNION ALL SELECT local_day FROM report_product_days
              UNION ALL SELECT local_day FROM report_search_days
            ) AS days`,
      )
      return row?.['day'] == null ? null : text(row['day'])
    },

    async liveSince(tx) {
      const [row] = await rows(
        tx,
        sql`SELECT MIN(local_day) AS day FROM (
              SELECT local_day FROM report_sales_hours WHERE source <> 'import'
              UNION ALL SELECT local_day FROM report_funnel_days
              UNION ALL SELECT local_day FROM report_product_days WHERE source <> 'import'
              UNION ALL SELECT local_day FROM report_search_days
            ) AS days`,
      )
      return row?.['day'] == null ? null : text(row['day'])
    },

    async salesTotals(tx, from, to) {
      const found = await rows(
        tx,
        sql`SELECT currency, source, SUM(captured_minor) AS captured, SUM(refunded_minor) AS refunded,
                   SUM(paid_orders) AS paid
            FROM report_sales_hours WHERE local_day >= ${from} AND local_day <= ${to}
            GROUP BY currency, source ORDER BY currency, source`,
      )
      return found.map((r) => ({
        currency: text(r['currency']),
        source: text(r['source']),
        capturedMinor: num(r['captured']),
        refundedMinor: num(r['refunded']),
        paidOrders: num(r['paid']),
      }))
    },

    async salesHours(tx, from, to) {
      const found = await rows(
        tx,
        sql`SELECT hour_start, local_day, timezone, currency, source, captured_minor, refunded_minor, paid_orders
            FROM report_sales_hours WHERE local_day >= ${from} AND local_day <= ${to}
            ORDER BY hour_start, currency, source`,
      )
      return found.map((r) => ({
        hourStart: new Date(text(r['hour_start'])),
        localDay: text(r['local_day']),
        timezone: text(r['timezone']),
        currency: text(r['currency']),
        source: text(r['source']),
        capturedMinor: num(r['captured_minor']),
        refundedMinor: num(r['refunded_minor']),
        paidOrders: num(r['paid_orders']),
      }))
    },

    async funnelTotals(tx, from, to) {
      const found = await rows(
        tx,
        sql`SELECT source, SUM(viewers) AS viewers, SUM(carts_with_items) AS carts,
                   SUM(checkouts_started) AS checkouts, SUM(payments_failed) AS failed
            FROM report_funnel_days WHERE local_day >= ${from} AND local_day <= ${to}
            GROUP BY source ORDER BY source`,
      )
      return found.map((r) => ({
        source: text(r['source']),
        viewers: num(r['viewers']),
        cartsWithItems: num(r['carts']),
        checkoutsStarted: num(r['checkouts']),
        paymentsFailed: num(r['failed']),
      }))
    },

    async funnelDays(tx, from, to) {
      const found = await rows(
        tx,
        sql`SELECT local_day, source, timezone, viewers, carts_with_items, checkouts_started, payments_failed
            FROM report_funnel_days WHERE local_day >= ${from} AND local_day <= ${to}
            ORDER BY local_day, source`,
      )
      return found.map((r) => ({
        localDay: text(r['local_day']),
        source: text(r['source']),
        timezone: text(r['timezone']),
        viewers: num(r['viewers']),
        cartsWithItems: num(r['carts_with_items']),
        checkoutsStarted: num(r['checkouts_started']),
        paymentsFailed: num(r['payments_failed']),
      }))
    },

    async productTotals(tx, from, to) {
      const found = await rows(
        tx,
        sql`SELECT product_id, MAX(product_name) AS name, currency, source, SUM(units) AS units,
                   SUM(line_subtotal_minor) AS subtotal
            FROM report_product_days WHERE local_day >= ${from} AND local_day <= ${to}
            GROUP BY product_id, currency, source
            HAVING SUM(units) > 0`,
      )
      return found.map((r) => ({
        productId: text(r['product_id']),
        productName: text(r['name']),
        currency: text(r['currency']),
        source: text(r['source']),
        units: num(r['units']),
        lineSubtotalMinor: num(r['subtotal']),
      }))
    },

    async unitsSold(tx, from, to) {
      const found = await rows(
        tx,
        sql`SELECT d.variant_id, MAX(d.product_id) AS product_id, MAX(d.product_name) AS name, MAX(d.sku) AS sku,
                   SUM(d.units) AS units, v.stock AS stock
            FROM report_product_days d JOIN variants v ON v.id = d.variant_id
            WHERE d.local_day >= ${from} AND d.local_day <= ${to}
            GROUP BY d.variant_id, v.stock
            HAVING SUM(d.units) > 0`,
      )
      return found.map((r) => ({
        variantId: text(r['variant_id']),
        productId: text(r['product_id']),
        productName: text(r['name']),
        sku: text(r['sku']),
        unitsSold: num(r['units']),
        stock: num(r['stock']),
      }))
    },

    async zeroResultTerms(tx, from, to, limit) {
      const found = await rows(
        tx,
        sql`SELECT term, SUM(searches) AS searches FROM report_search_days
            WHERE local_day >= ${from} AND local_day <= ${to}
            GROUP BY term ORDER BY SUM(searches) DESC, term LIMIT ${limit}`,
      )
      return found.map((r) => ({ term: text(r['term']), searches: num(r['searches']) }))
    },

    async newZeroResultTerms(tx, day, quietFrom, minSearches) {
      const found = await rows(
        tx,
        sql`SELECT d.term, d.searches FROM report_search_days d
            WHERE d.local_day = ${day} AND d.searches >= ${minSearches}
              AND NOT EXISTS (
                SELECT 1 FROM report_search_days q
                WHERE q.term = d.term AND q.local_day >= ${quietFrom} AND q.local_day < ${day}
              )
            ORDER BY d.searches DESC, d.term`,
      )
      return found.map((r) => ({ term: text(r['term']), searches: num(r['searches']) }))
    },
  }
}
