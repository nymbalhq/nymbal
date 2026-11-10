import { and, eq, gt, lte } from 'drizzle-orm'
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

export interface SingleUseTokenInsert {
  id: string
  customerId: string
  /** sha256 hex of the token; the token itself is never stored. */
  tokenHash: string
  expiresAt: Date
  createdAt: Date
}

export interface SingleUseTokenRow {
  id: string
  customerId: string
  tokenHash: string
  expiresAt: Date
  createdAt: Date
}

/** A mailed link's token, kept as its hash. A row is live while `now` is before its `expires_at`. */
export interface SingleUseTokenRepository extends StoreRepository {
  insert(tx: Tx, row: SingleUseTokenInsert): Promise<void>
  findLive(tx: ReadTx, tokenHash: string, now: Date): Promise<SingleUseTokenRow | null>
  findLiveForCustomer(tx: ReadTx, customerId: string, now: Date): Promise<SingleUseTokenRow | null>
  /** Deletes the live row with this hash and answers its customer, or null when none was live: the one use. */
  consume(tx: Tx, tokenHash: string, now: Date): Promise<string | null>
  deleteByCustomer(tx: Tx, customerId: string): Promise<void>
  purgeExpired(tx: Tx, now: Date): Promise<number>
}

export type PasswordResetTokenInsert = SingleUseTokenInsert
export type PasswordResetTokenRow = SingleUseTokenRow
export type PasswordResetTokenRepository = SingleUseTokenRepository

/** The tables of one kind of link: each dialect's, with the same columns. */
export interface SingleUseTokenTables {
  sqlite: typeof sqliteSchema.passwordResetTokens | typeof sqliteSchema.emailVerificationTokens
  postgres:
    | typeof postgresSchema.passwordResetTokens
    | typeof postgresSchema.emailVerificationTokens
}

function fromSqlite(row: {
  id: string
  customerId: string
  tokenHash: string
  expiresAt: string
  createdAt: string
}): SingleUseTokenRow {
  return {
    id: row.id,
    customerId: row.customerId,
    tokenHash: row.tokenHash,
    expiresAt: new Date(row.expiresAt),
    createdAt: new Date(row.createdAt),
  }
}

export function createPasswordResetTokenRepository(
  store: CommandStore,
): PasswordResetTokenRepository {
  return createSingleUseTokenRepository(store, {
    sqlite: sqliteSchema.passwordResetTokens,
    postgres: postgresSchema.passwordResetTokens,
  })
}

export function createSingleUseTokenRepository(
  store: CommandStore,
  tables: SingleUseTokenTables,
): SingleUseTokenRepository {
  return {
    store,
    async insert(tx, row) {
      const common = { id: row.id, customerId: row.customerId, tokenHash: row.tokenHash }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(tables.sqlite)
          .values({
            ...common,
            expiresAt: row.expiresAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
          })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(tables.postgres)
        .values({ ...common, expiresAt: row.expiresAt, createdAt: row.createdAt })
    },
    async findLive(tx, tokenHash, now) {
      if (tx.kind === 'sqlite') {
        const t = tables.sqlite
        const row = sqliteDb(tx)
          .select()
          .from(t)
          .where(and(eq(t.tokenHash, tokenHash), gt(t.expiresAt, now.toISOString())))
          .get()
        return row === undefined ? null : fromSqlite(row)
      }
      const t = tables.postgres
      const [row] = await postgresDb(tx)
        .select()
        .from(t)
        .where(and(eq(t.tokenHash, tokenHash), gt(t.expiresAt, now)))
        .limit(1)
      return row ?? null
    },
    async findLiveForCustomer(tx, customerId, now) {
      if (tx.kind === 'sqlite') {
        const t = tables.sqlite
        const row = sqliteDb(tx)
          .select()
          .from(t)
          .where(and(eq(t.customerId, customerId), gt(t.expiresAt, now.toISOString())))
          .get()
        return row === undefined ? null : fromSqlite(row)
      }
      const t = tables.postgres
      const [row] = await postgresDb(tx)
        .select()
        .from(t)
        .where(and(eq(t.customerId, customerId), gt(t.expiresAt, now)))
        .limit(1)
      return row ?? null
    },
    async consume(tx, tokenHash, now) {
      if (tx.kind === 'sqlite') {
        const t = tables.sqlite
        const [row] = sqliteDb(tx)
          .delete(t)
          .where(and(eq(t.tokenHash, tokenHash), gt(t.expiresAt, now.toISOString())))
          .returning({ customerId: t.customerId })
          .all()
        return row?.customerId ?? null
      }
      const t = tables.postgres
      const [row] = await postgresDb(tx)
        .delete(t)
        .where(and(eq(t.tokenHash, tokenHash), gt(t.expiresAt, now)))
        .returning({ customerId: t.customerId })
      return row?.customerId ?? null
    },
    async deleteByCustomer(tx, customerId) {
      if (tx.kind === 'sqlite') {
        const t = tables.sqlite
        sqliteDb(tx).delete(t).where(eq(t.customerId, customerId)).run()
        return
      }
      const t = tables.postgres
      await postgresDb(tx).delete(t).where(eq(t.customerId, customerId))
    },
    async purgeExpired(tx, now) {
      if (tx.kind === 'sqlite') {
        const t = tables.sqlite
        return sqliteDb(tx).delete(t).where(lte(t.expiresAt, now.toISOString())).run().changes
      }
      const t = tables.postgres
      const deleted = await postgresDb(tx)
        .delete(t)
        .where(lte(t.expiresAt, now))
        .returning({ id: t.id })
      return deleted.length
    },
  }
}
