import { and, asc, eq, inArray } from 'drizzle-orm'
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

/** Who minted the key: a checkout answer, or the order-placed email. */
export type OrderAccessKeyPurpose = 'checkout' | 'email'

/** What a key does for an order: opens it, has expired, or is not one of its keys. */
export type OrderKeyState = 'open' | 'expired' | 'none'

export interface OrderAccessKeyInsert {
  id: string
  orderId: string
  /** sha256 hex of the key; the key itself is never stored. */
  keyHash: string
  purpose: OrderAccessKeyPurpose
  createdAt: Date
  expiresAt: Date
}

export interface OrderAccessKeyRepository extends StoreRepository {
  insert(tx: Tx, k: OrderAccessKeyInsert): Promise<void>
  /** What a key with this hash does for this order at `now`: another order's key is `none` here. */
  opens(tx: ReadTx, orderId: string, keyHash: string, now: Date): Promise<OrderKeyState>
  /** Deletes the order's oldest keys of `purpose`, by `(created_at, id)`, until at most `keep` remain. */
  keepNewest(tx: Tx, orderId: string, purpose: OrderAccessKeyPurpose, keep: number): Promise<void>
}

export function createOrderAccessKeyRepository(store: CommandStore): OrderAccessKeyRepository {
  return {
    store,
    async insert(tx, k) {
      const row = { id: k.id, orderId: k.orderId, keyHash: k.keyHash, purpose: k.purpose }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.orderAccessKeys)
          .values({
            ...row,
            createdAt: k.createdAt.toISOString(),
            expiresAt: k.expiresAt.toISOString(),
          })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.orderAccessKeys)
        .values({ ...row, createdAt: k.createdAt, expiresAt: k.expiresAt })
    },
    async opens(tx, orderId, keyHash, now) {
      let expiresAt: number | undefined
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.orderAccessKeys
        const row = sqliteDb(tx)
          .select({ expiresAt: t.expiresAt })
          .from(t)
          .where(and(eq(t.orderId, orderId), eq(t.keyHash, keyHash)))
          .get()
        if (row !== undefined) expiresAt = Date.parse(row.expiresAt)
      } else {
        const t = postgresSchema.orderAccessKeys
        const rows = await postgresDb(tx)
          .select({ expiresAt: t.expiresAt })
          .from(t)
          .where(and(eq(t.orderId, orderId), eq(t.keyHash, keyHash)))
          .limit(1)
        if (rows[0] !== undefined) expiresAt = rows[0].expiresAt.getTime()
      }
      if (expiresAt === undefined) return 'none'
      return now.getTime() < expiresAt ? 'open' : 'expired'
    },
    async keepNewest(tx, orderId, purpose, keep) {
      let ids: string[]
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.orderAccessKeys
        ids = sqliteDb(tx)
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.orderId, orderId), eq(t.purpose, purpose)))
          .orderBy(asc(t.createdAt), asc(t.id))
          .all()
          .map((r) => r.id)
      } else {
        const t = postgresSchema.orderAccessKeys
        const rows = await postgresDb(tx)
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.orderId, orderId), eq(t.purpose, purpose)))
          .orderBy(asc(t.createdAt), asc(t.id))
        ids = rows.map((r) => r.id)
      }
      const stale = ids.slice(0, Math.max(0, ids.length - keep))
      if (stale.length === 0) return
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.orderAccessKeys
        sqliteDb(tx).delete(t).where(inArray(t.id, stale)).run()
        return
      }
      const t = postgresSchema.orderAccessKeys
      await postgresDb(tx).delete(t).where(inArray(t.id, stale))
    },
  }
}
