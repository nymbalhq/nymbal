import { and, asc, eq, lt, sql } from 'drizzle-orm'
import {
  postgresDb,
  sqliteDb,
  type CommandStore,
  type ReadTx,
  type StoreRepository,
  type Tx,
} from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { fromTimestamp, parseJson } from './json.js'

/** The longest provider error kept on a record: an error page is not worth storing whole. */
const LAST_ERROR_MAX = 500

export interface OrderTaxDocument {
  orderId: string
  /** The tax adapter's `providerName` when the record was made. */
  provider: string
  status: 'pending' | 'committed'
  documentId: string | null
  committedAt: string | null
  /** Σ amounts of `filedRefundIds`. */
  refundedMinor: number
  /** The `order_refunds.id`s filed, in filing order. */
  filedRefundIds: string[]
  /** Failed provider calls since the record was last clear. */
  attempts: number
  lastError: string | null
  /** Since when the record has owed the provider a commit or a refund; null when nothing is owed. */
  dueSince: string | null
  createdAt: string
  updatedAt: string
}

export interface DueSummary {
  count: number
  /** The record owed longest, by `dueSince`. */
  oldest: { orderId: string; provider: string; lastError: string | null } | null
}

export interface OrderTaxDocumentRepository extends StoreRepository {
  find(tx: ReadTx, orderId: string): Promise<OrderTaxDocument | null>
  /** The record, read under its row lock until the transaction ends (Postgres `FOR UPDATE`; on SQLite the open
   *  `BEGIN IMMEDIATE` transaction already holds every write). */
  lock(tx: Tx, orderId: string): Promise<OrderTaxDocument | null>
  /** Makes the order's record `pending`; does nothing when it has one. */
  insertPending(tx: Tx, row: { orderId: string; provider: string; at: Date }): Promise<void>
  /** Records the provider's document; false unless the record was `pending`. */
  commit(tx: Tx, orderId: string, documentId: string, at: Date): Promise<boolean>
  /** Files a refund and adds its amount in one update; false when the refund is already filed. */
  addRefund(
    tx: Tx,
    orderId: string,
    refundId: string,
    amountMinor: number,
    at: Date,
  ): Promise<boolean>
  /** Counts a failed provider call and keeps its message; the record is due from `at` unless it already was. */
  recordFailure(tx: Tx, orderId: string, message: string, at: Date): Promise<void>
  /** The record is due from `at` unless it already was. */
  markDue(tx: Tx, orderId: string, at: Date): Promise<void>
  /** Nothing is owed: no attempts, no error, not due. */
  clear(tx: Tx, orderId: string, at: Date): Promise<void>
  /** The provider's records due since before `before`, the least recently written first, at most `limit`. */
  listDue(
    tx: ReadTx,
    query: { provider: string; before: Date; limit: number },
  ): Promise<OrderTaxDocument[]>
  /** How many records are due since before `before`, and the one owed longest. */
  dueSummary(tx: ReadTx, before: Date): Promise<DueSummary>
}

function rowToDocument(
  kind: 'sqlite' | 'postgres',
  row: Record<string, unknown>,
): OrderTaxDocument {
  const at = (value: unknown) => (value == null ? null : fromTimestamp(value))
  return {
    orderId: String(row.orderId),
    provider: String(row.provider),
    status: row.status as OrderTaxDocument['status'],
    documentId: (row.documentId as string | null) ?? null,
    committedAt: at(row.committedAt),
    refundedMinor: Number(row.refundedMinor),
    filedRefundIds: parseJson<string[]>(kind, row.filedRefundIds, []),
    attempts: Number(row.attempts),
    lastError: (row.lastError as string | null) ?? null,
    dueSince: at(row.dueSince),
    createdAt: fromTimestamp(row.createdAt),
    updatedAt: fromTimestamp(row.updatedAt),
  }
}

export function createOrderTaxDocumentRepository(store: CommandStore): OrderTaxDocumentRepository {
  const s = sqliteSchema.orderTaxDocuments
  const p = postgresSchema.orderTaxDocuments

  return {
    store,
    async find(tx, orderId) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx).select().from(s).where(eq(s.orderId, orderId)).get()
        return row ? rowToDocument('sqlite', row) : null
      }
      const [row] = await postgresDb(tx).select().from(p).where(eq(p.orderId, orderId))
      return row ? rowToDocument('postgres', row) : null
    },
    async lock(tx, orderId) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx).select().from(s).where(eq(s.orderId, orderId)).get()
        return row ? rowToDocument('sqlite', row) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(p)
        .where(eq(p.orderId, orderId))
        .for('update')
      return row ? rowToDocument('postgres', row) : null
    },
    async insertPending(tx, { orderId, provider, at }) {
      if (tx.kind === 'sqlite') {
        const iso = at.toISOString()
        sqliteDb(tx)
          .insert(s)
          .values({ orderId, provider, createdAt: iso, updatedAt: iso })
          .onConflictDoNothing()
          .run()
        return
      }
      await postgresDb(tx)
        .insert(p)
        .values({ orderId, provider, createdAt: at, updatedAt: at })
        .onConflictDoNothing()
    },
    async commit(tx, orderId, documentId, at) {
      if (tx.kind === 'sqlite') {
        const iso = at.toISOString()
        const { changes } = sqliteDb(tx)
          .update(s)
          .set({ status: 'committed', documentId, committedAt: iso, updatedAt: iso })
          .where(and(eq(s.orderId, orderId), eq(s.status, 'pending')))
          .run()
        return changes > 0
      }
      const result = await postgresDb(tx)
        .update(p)
        .set({ status: 'committed', documentId, committedAt: at, updatedAt: at })
        .where(and(eq(p.orderId, orderId), eq(p.status, 'pending')))
      return (result.rowCount ?? 0) > 0
    },
    async addRefund(tx, orderId, refundId, amountMinor, at) {
      if (tx.kind === 'sqlite') {
        const { changes } = sqliteDb(tx)
          .update(s)
          .set({
            filedRefundIds: sql`json_insert(${s.filedRefundIds}, '$[#]', ${refundId})`,
            refundedMinor: sql`${s.refundedMinor} + ${amountMinor}`,
            updatedAt: at.toISOString(),
          })
          .where(
            and(
              eq(s.orderId, orderId),
              sql`not exists (select 1 from json_each(${s.filedRefundIds}) where value = ${refundId})`,
            ),
          )
          .run()
        return changes > 0
      }
      const result = await postgresDb(tx)
        .update(p)
        .set({
          filedRefundIds: sql`${p.filedRefundIds} || jsonb_build_array(${refundId}::text)`,
          refundedMinor: sql`${p.refundedMinor} + ${amountMinor}`,
          updatedAt: at,
        })
        .where(
          and(
            eq(p.orderId, orderId),
            sql`not (${p.filedRefundIds} @> jsonb_build_array(${refundId}::text))`,
          ),
        )
      return (result.rowCount ?? 0) > 0
    },
    async recordFailure(tx, orderId, message, at) {
      const lastError = message.slice(0, LAST_ERROR_MAX)
      if (tx.kind === 'sqlite') {
        const iso = at.toISOString()
        sqliteDb(tx)
          .update(s)
          .set({
            attempts: sql`${s.attempts} + 1`,
            lastError,
            dueSince: sql`coalesce(${s.dueSince}, ${iso})`,
            updatedAt: iso,
          })
          .where(eq(s.orderId, orderId))
          .run()
        return
      }
      await postgresDb(tx)
        .update(p)
        .set({
          attempts: sql`${p.attempts} + 1`,
          lastError,
          dueSince: sql`coalesce(${p.dueSince}, ${at.toISOString()}::timestamptz)`,
          updatedAt: at,
        })
        .where(eq(p.orderId, orderId))
    },
    async markDue(tx, orderId, at) {
      if (tx.kind === 'sqlite') {
        const iso = at.toISOString()
        sqliteDb(tx)
          .update(s)
          .set({ dueSince: sql`coalesce(${s.dueSince}, ${iso})`, updatedAt: iso })
          .where(eq(s.orderId, orderId))
          .run()
        return
      }
      await postgresDb(tx)
        .update(p)
        .set({
          dueSince: sql`coalesce(${p.dueSince}, ${at.toISOString()}::timestamptz)`,
          updatedAt: at,
        })
        .where(eq(p.orderId, orderId))
    },
    async clear(tx, orderId, at) {
      const cleared = { attempts: 0, lastError: null, dueSince: null }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(s)
          .set({ ...cleared, updatedAt: at.toISOString() })
          .where(eq(s.orderId, orderId))
          .run()
        return
      }
      await postgresDb(tx)
        .update(p)
        .set({ ...cleared, updatedAt: at })
        .where(eq(p.orderId, orderId))
    },
    async listDue(tx, { provider, before, limit }) {
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx)
          .select()
          .from(s)
          .where(and(eq(s.provider, provider), lt(s.dueSince, before.toISOString())))
          .orderBy(asc(s.updatedAt), asc(s.orderId))
          .limit(limit)
          .all()
          .map((row) => rowToDocument('sqlite', row))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(p)
        .where(and(eq(p.provider, provider), lt(p.dueSince, before)))
        .orderBy(asc(p.updatedAt), asc(p.orderId))
        .limit(limit)
      return rows.map((row) => rowToDocument('postgres', row))
    },
    async dueSummary(tx, before) {
      if (tx.kind === 'sqlite') {
        const due = lt(s.dueSince, before.toISOString())
        const db = sqliteDb(tx)
        const counted = db
          .select({ n: sql<number>`count(*)` })
          .from(s)
          .where(due)
          .get()
        const oldest = db
          .select({ orderId: s.orderId, provider: s.provider, lastError: s.lastError })
          .from(s)
          .where(due)
          .orderBy(asc(s.dueSince), asc(s.orderId))
          .limit(1)
          .get()
        return { count: Number(counted?.n ?? 0), oldest: oldest ?? null }
      }
      const due = lt(p.dueSince, before)
      const db = postgresDb(tx)
      const [counted] = await db
        .select({ n: sql<string>`count(*)` })
        .from(p)
        .where(due)
      const [oldest] = await db
        .select({ orderId: p.orderId, provider: p.provider, lastError: p.lastError })
        .from(p)
        .where(due)
        .orderBy(asc(p.dueSince), asc(p.orderId))
        .limit(1)
      return { count: Number(counted?.n ?? 0), oldest: oldest ?? null }
    },
  }
}
