import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { NymbalEvent } from '@nymbalhq/types'
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

export interface LoggedEvent {
  seq: number
  event: NymbalEvent<unknown>
  deliveredAt: Date | null
  attempts: number
  deadAt: Date | null
}

export interface EventLogRepository extends StoreRepository {
  /** Appends in array order, so `seq` follows publish order. */
  append(tx: Tx, events: NymbalEvent<unknown>[]): Promise<void>
  /** Neither delivered nor dead, by `seq`; `afterSeq` pages through one pass without re-reading rows it just tried. */
  listUndelivered(tx: ReadTx, limit: number, afterSeq?: number): Promise<LoggedEvent[]>
  markDelivered(tx: Tx, ids: string[], at: Date): Promise<void>
  /** One more failed attempt; the event is dead (`dead_at = at`) once its attempts reach `maxAttempts`. */
  recordFailure(tx: Tx, id: string, at: Date, maxAttempts: number): Promise<void>
  /** Deletes delivered events delivered before `at`; returns how many. Undelivered and dead events are never deleted. */
  deleteDeliveredBefore(tx: Tx, at: Date): Promise<number>
  listAll(tx: ReadTx): Promise<LoggedEvent[]>
}

// SQLite's bound-parameter limit is per statement; seven columns a row keeps a chunk well under it.
const APPEND_CHUNK = 100

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(String(value))
}

function rowToLogged(row: {
  seq: number
  envelope: unknown
  deliveredAt: unknown
  attempts: number
  deadAt: unknown
}): LoggedEvent {
  const envelope =
    typeof row.envelope === 'string'
      ? (JSON.parse(row.envelope) as NymbalEvent<unknown>)
      : (row.envelope as NymbalEvent<unknown>)
  return {
    seq: Number(row.seq),
    event: envelope,
    deliveredAt: toDate(row.deliveredAt),
    attempts: Number(row.attempts),
    deadAt: toDate(row.deadAt),
  }
}

export function createEventLogRepository(store: CommandStore): EventLogRepository {
  const s = sqliteSchema.events
  const p = postgresSchema.events
  return {
    store,
    async append(tx, events) {
      const now = new Date()
      for (let i = 0; i < events.length; i += APPEND_CHUNK) {
        const chunk = events.slice(i, i + APPEND_CHUNK)
        if (tx.kind === 'sqlite') {
          sqliteDb(tx)
            .insert(s)
            .values(
              chunk.map((e) => ({
                id: e.id,
                type: e.type,
                envelope: JSON.stringify(e),
                createdAt: now.toISOString(),
              })),
            )
            .run()
        } else {
          await postgresDb(tx)
            .insert(p)
            .values(chunk.map((e) => ({ id: e.id, type: e.type, envelope: e, createdAt: now })))
        }
      }
    },
    async listUndelivered(tx, limit, afterSeq = 0) {
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx)
          .select()
          .from(s)
          .where(and(isNull(s.deliveredAt), isNull(s.deadAt), gt(s.seq, afterSeq)))
          .orderBy(asc(s.seq))
          .limit(limit)
          .all()
          .map(rowToLogged)
      }
      const rows = await postgresDb(tx)
        .select()
        .from(p)
        .where(and(isNull(p.deliveredAt), isNull(p.deadAt), gt(p.seq, afterSeq)))
        .orderBy(asc(p.seq))
        .limit(limit)
      return rows.map(rowToLogged)
    },
    async markDelivered(tx, ids, at) {
      if (ids.length === 0) return
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(s)
          .set({ deliveredAt: at.toISOString() })
          .where(inArray(s.id, ids))
          .run()
        return
      }
      await postgresDb(tx).update(p).set({ deliveredAt: at }).where(inArray(p.id, ids))
    },
    async recordFailure(tx, id, at, maxAttempts) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(s)
          .set({
            attempts: sql`${s.attempts} + 1`,
            deadAt: sql`CASE WHEN ${s.attempts} + 1 >= ${maxAttempts} THEN ${at.toISOString()} ELSE ${s.deadAt} END`,
          })
          .where(eq(s.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(p)
        .set({
          attempts: sql`${p.attempts} + 1`,
          deadAt: sql`CASE WHEN ${p.attempts} + 1 >= ${maxAttempts} THEN ${at.toISOString()}::timestamptz ELSE ${p.deadAt} END`,
        })
        .where(eq(p.id, id))
    },
    async deleteDeliveredBefore(tx, at) {
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .delete(s)
          .where(and(isNotNull(s.deliveredAt), lt(s.deliveredAt, at.toISOString())))
          .run()
        return result.changes
      }
      const result = await postgresDb(tx)
        .delete(p)
        .where(and(isNotNull(p.deliveredAt), lt(p.deliveredAt, at)))
      return result.rowCount ?? 0
    },
    async listAll(tx) {
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx).select().from(s).orderBy(asc(s.seq)).all().map(rowToLogged)
      }
      const rows = await postgresDb(tx).select().from(p).orderBy(asc(p.seq))
      return rows.map(rowToLogged)
    },
  }
}
