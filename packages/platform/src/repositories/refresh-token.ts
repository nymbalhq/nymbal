import { and, eq, isNull, lt } from 'drizzle-orm'
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
  rotate(tx: Tx, oldJti: string, next: RefreshTokenInsert): Promise<void>
  revoke(tx: Tx, id: string): Promise<void>
  revokeAllForCustomer(tx: Tx, customerId: string): Promise<void>
  purgeExpired(tx: Tx, now: Date): Promise<number>
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
        db.update(sqliteSchema.refreshTokens)
          .set({ revokedAt: new Date().toISOString(), replacedByJti: next.id })
          .where(eq(sqliteSchema.refreshTokens.id, oldJti))
          .run()
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
        return
      }
      const db = postgresDb(tx)
      await db
        .update(postgresSchema.refreshTokens)
        .set({ revokedAt: new Date(), replacedByJti: next.id })
        .where(eq(postgresSchema.refreshTokens.id, oldJti))
      await db.insert(postgresSchema.refreshTokens).values({
        id: next.id,
        customerId: next.customerId,
        tokenHash: next.tokenHash,
        revokedAt: null,
        replacedByJti: null,
        expiresAt: next.expiresAt,
        createdAt: next.createdAt,
      })
    },
    async revoke(tx, id) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.refreshTokens)
          .set({ revokedAt: new Date().toISOString() })
          .where(
            and(
              eq(sqliteSchema.refreshTokens.id, id),
              isNull(sqliteSchema.refreshTokens.revokedAt),
            ),
          )
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(postgresSchema.refreshTokens.id, id),
            isNull(postgresSchema.refreshTokens.revokedAt),
          ),
        )
    },
    async revokeAllForCustomer(tx, customerId) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.refreshTokens)
          .set({ revokedAt: new Date().toISOString() })
          .where(eq(sqliteSchema.refreshTokens.customerId, customerId))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(postgresSchema.refreshTokens.customerId, customerId))
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
  }
}
