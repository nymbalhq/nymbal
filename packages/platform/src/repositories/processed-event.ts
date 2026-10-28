import { and, eq, lt } from 'drizzle-orm'
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

/** Which handler has already run for which event id: what stops a side effect running twice, across restarts. */
export interface ProcessedEventRepository extends StoreRepository {
  seen(tx: ReadTx, handlerName: string, eventId: string): Promise<boolean>
  /** Idempotent on (handlerName, eventId): a second call keeps the first record. */
  markProcessed(tx: Tx, handlerName: string, eventId: string, at: Date): Promise<void>
  /**
   * Records (handlerName, eventId) before its work runs: true when this call inserted it, false when it was there.
   * On Postgres a concurrent claim of the same key waits for this transaction, so only one of them does the work.
   */
  claim(tx: Tx, handlerName: string, eventId: string, at: Date): Promise<boolean>
  /** Deletes records processed before `at`; returns how many. */
  deleteBefore(tx: Tx, at: Date): Promise<number>
}

export function createProcessedEventRepository(store: CommandStore): ProcessedEventRepository {
  const s = sqliteSchema.processedEvents
  const p = postgresSchema.processedEvents
  return {
    store,
    async seen(tx, handlerName, eventId) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select({ eventId: s.eventId })
          .from(s)
          .where(and(eq(s.handlerName, handlerName), eq(s.eventId, eventId)))
          .get()
        return row !== undefined
      }
      const rows = await postgresDb(tx)
        .select({ eventId: p.eventId })
        .from(p)
        .where(and(eq(p.handlerName, handlerName), eq(p.eventId, eventId)))
        .limit(1)
      return rows.length > 0
    },
    async markProcessed(tx, handlerName, eventId, at) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(s)
          .values({ handlerName, eventId, processedAt: at.toISOString() })
          .onConflictDoNothing()
          .run()
        return
      }
      await postgresDb(tx)
        .insert(p)
        .values({ handlerName, eventId, processedAt: at })
        .onConflictDoNothing()
    },
    async claim(tx, handlerName, eventId, at) {
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .insert(s)
          .values({ handlerName, eventId, processedAt: at.toISOString() })
          .onConflictDoNothing()
          .run()
        return result.changes > 0
      }
      const result = await postgresDb(tx)
        .insert(p)
        .values({ handlerName, eventId, processedAt: at })
        .onConflictDoNothing()
      return (result.rowCount ?? 0) > 0
    },
    async deleteBefore(tx, at) {
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx).delete(s).where(lt(s.processedAt, at.toISOString())).run().changes
      }
      const result = await postgresDb(tx).delete(p).where(lt(p.processedAt, at))
      return result.rowCount ?? 0
    },
  }
}
