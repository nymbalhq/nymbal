import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
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
import { fromTimestamp } from './json.js'

export interface RefreshTokenInsert {
  id: string
  customerId: string
  tokenHash: string
  expiresAt: Date
  createdAt: Date
}

export interface RefreshTokenRow {
  id: string
  customerId: string
  tokenHash: string
  revokedAt: string | null
  replacedByJti: string | null
  expiresAt: string
  createdAt: string
}

function rowToToken(row: Record<string, unknown>): RefreshTokenRow {
  return {
    id: String(row.id),
    customerId: String(row.customerId),
    tokenHash: String(row.tokenHash),
    revokedAt: row.revokedAt == null ? null : fromTimestamp(row.revokedAt),
    replacedByJti: (row.replacedByJti as string | null) ?? null,
    expiresAt: fromTimestamp(row.expiresAt),
    createdAt: fromTimestamp(row.createdAt),
  }
}

export interface RefreshTokenRepository extends StoreRepository {
  insert(tx: Tx, t: RefreshTokenInsert): Promise<void>
  findById(tx: ReadTx, id: string): Promise<RefreshTokenRow | null>
  /**
   * Inserts `next` as the successor of `oldJti` if that row is live or already rotated, and returns whether it did. A
   * row revoked with no successor, or gone, is refused with nothing written: the decision is the `UPDATE`'s, so it
   * holds against a sign-out that committed after the caller read the row. The old row's `revokedAt` is set only if it
   * has none: re-rotating a token inside the reuse window keeps the instant of its first rotation, so the window never
   * slides.
   */
  rotate(tx: Tx, oldJti: string, next: RefreshTokenInsert): Promise<boolean>
  /** True when this call revoked a live row; a rotated, revoked or absent row is left as it was. */
  revoke(tx: Tx, id: string): Promise<boolean>
  /**
   * Ends every row of the customer that is live or rotated: earlier `revokedAt` instants stay, and clearing
   * `replacedByJti` stops a rotated row being rotated again. On Postgres the rows are locked first, so a rotation in
   * flight commits before the `UPDATE` takes its snapshot and the `UPDATE` sees the successor.
   */
  revokeAllForCustomer(tx: Tx, customerId: string): Promise<void>
  purgeExpired(tx: Tx, now: Date): Promise<number>
  /**
   * Deletes rotated rows (a successor is recorded) revoked before `revokedBefore`. Rows revoked with no successor
   * (logout, sign-out of every session) stay until they expire, so presenting one stays a plain refusal.
   */
  purgeRotated(tx: Tx, revokedBefore: Date): Promise<number>
  deleteByCustomer(tx: Tx, customerId: string): Promise<void>
}

function isRotatable(t: typeof sqliteSchema.refreshTokens | typeof postgresSchema.refreshTokens) {
  return or(isNull(t.revokedAt), isNotNull(t.replacedByJti))
}

export function createRefreshTokenRepository(store: CommandStore): RefreshTokenRepository {
  return {
    store,
    async insert(tx, t) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.refreshTokens)
          .values({
            id: t.id,
            customerId: t.customerId,
            tokenHash: t.tokenHash,
            revokedAt: null,
            replacedByJti: null,
            expiresAt: t.expiresAt.toISOString(),
            createdAt: t.createdAt.toISOString(),
          })
          .run()
        return
      }
      await postgresDb(tx).insert(postgresSchema.refreshTokens).values({
        id: t.id,
        customerId: t.customerId,
        tokenHash: t.tokenHash,
        revokedAt: null,
        replacedByJti: null,
        expiresAt: t.expiresAt,
        createdAt: t.createdAt,
      })
    },
    async findById(tx, id) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.refreshTokens)
          .where(eq(sqliteSchema.refreshTokens.id, id))
          .get()
        return row ? rowToToken(row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.refreshTokens)
        .where(eq(postgresSchema.refreshTokens.id, id))
      return row ? rowToToken(row as Record<string, unknown>) : null
    },
    async rotate(tx, oldJti, next) {
      if (tx.kind === 'sqlite') {
        const db = sqliteDb(tx)
        const old = sqliteSchema.refreshTokens
        const result = db
          .update(old)
          .set({
            replacedByJti: next.id,
            revokedAt: sql`COALESCE(${old.revokedAt}, ${new Date().toISOString()})`,
          })
          .where(and(eq(old.id, oldJti), isRotatable(old)))
          .run()
        if (result.changes !== 1) return false
        db.insert(sqliteSchema.refreshTokens)
          .values({
            id: next.id,
            customerId: next.customerId,
            tokenHash: next.tokenHash,
            revokedAt: null,
            replacedByJti: null,
            expiresAt: next.expiresAt.toISOString(),
            createdAt: next.createdAt.toISOString(),
          })
          .run()
        return true
      }
      const db = postgresDb(tx)
      const old = postgresSchema.refreshTokens
      const result = await db
        .update(old)
        .set({
          replacedByJti: next.id,
          revokedAt: sql`COALESCE(${old.revokedAt}, ${new Date()})`,
        })
        .where(and(eq(old.id, oldJti), isRotatable(old)))
      if (result.rowCount !== 1) return false
      await db.insert(postgresSchema.refreshTokens).values({
        id: next.id,
        customerId: next.customerId,
        tokenHash: next.tokenHash,
        revokedAt: null,
        replacedByJti: null,
        expiresAt: next.expiresAt,
        createdAt: next.createdAt,
      })
      return true
    },
    async revoke(tx, id) {
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .update(sqliteSchema.refreshTokens)
          .set({ revokedAt: new Date().toISOString() })
          .where(
            and(
              eq(sqliteSchema.refreshTokens.id, id),
              isNull(sqliteSchema.refreshTokens.revokedAt),
            ),
          )
          .run()
        return result.changes === 1
      }
      const result = await postgresDb(tx)
        .update(postgresSchema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(postgresSchema.refreshTokens.id, id),
            isNull(postgresSchema.refreshTokens.revokedAt),
          ),
        )
      return result.rowCount === 1
    },
    async revokeAllForCustomer(tx, customerId) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.refreshTokens
        sqliteDb(tx)
          .update(t)
          .set({
            revokedAt: sql`COALESCE(${t.revokedAt}, ${new Date().toISOString()})`,
            replacedByJti: null,
          })
          .where(and(eq(t.customerId, customerId), isRotatable(t)))
          .run()
        return
      }
      const db = postgresDb(tx)
      const t = postgresSchema.refreshTokens
      const ofCustomer = and(eq(t.customerId, customerId), isRotatable(t))
      await db.select({ id: t.id }).from(t).where(ofCustomer).orderBy(t.id).for('update')
      await db
        .update(t)
        .set({ revokedAt: sql`COALESCE(${t.revokedAt}, ${new Date()})`, replacedByJti: null })
        .where(ofCustomer)
    },
    async purgeExpired(tx, now) {
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .delete(sqliteSchema.refreshTokens)
          .where(lt(sqliteSchema.refreshTokens.expiresAt, now.toISOString()))
          .run()
        return result.changes
      }
      const result = await postgresDb(tx)
        .delete(postgresSchema.refreshTokens)
        .where(lt(postgresSchema.refreshTokens.expiresAt, now))
      return result.rowCount ?? 0
    },
    async purgeRotated(tx, revokedBefore) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.refreshTokens
        const result = sqliteDb(tx)
          .delete(t)
          .where(and(isNotNull(t.replacedByJti), lt(t.revokedAt, revokedBefore.toISOString())))
          .run()
        return result.changes
      }
      const t = postgresSchema.refreshTokens
      const result = await postgresDb(tx)
        .delete(t)
        .where(and(isNotNull(t.replacedByJti), lt(t.revokedAt, revokedBefore)))
      return result.rowCount ?? 0
    },
    async deleteByCustomer(tx, customerId) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.refreshTokens
        sqliteDb(tx).delete(t).where(eq(t.customerId, customerId)).run()
        return
      }
      const t = postgresSchema.refreshTokens
      await postgresDb(tx).delete(t).where(eq(t.customerId, customerId))
    },
  }
}
