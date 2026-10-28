import { and, eq } from 'drizzle-orm'
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

export interface OrderAccessKeyInsert {
  id: string
  orderId: string
  /** sha256 hex of the key; the key itself is never stored. */
  keyHash: string
  purpose: OrderAccessKeyPurpose
  createdAt: Date
}

export interface OrderAccessKeyRepository extends StoreRepository {
  insert(tx: Tx, k: OrderAccessKeyInsert): Promise<void>
  /** Whether a key with this hash opens this order: another order's key opens nothing here. */
  opens(tx: ReadTx, orderId: string, keyHash: string): Promise<boolean>
}

export function createOrderAccessKeyRepository(store: CommandStore): OrderAccessKeyRepository {
  return {
    store,
    async insert(tx, k) {
      const row = { id: k.id, orderId: k.orderId, keyHash: k.keyHash, purpose: k.purpose }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.orderAccessKeys)
          .values({ ...row, createdAt: k.createdAt.toISOString() })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.orderAccessKeys)
        .values({ ...row, createdAt: k.createdAt })
    },
    async opens(tx, orderId, keyHash) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.orderAccessKeys
        const row = sqliteDb(tx)
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.orderId, orderId), eq(t.keyHash, keyHash)))
          .get()
        return row !== undefined
      }
      const t = postgresSchema.orderAccessKeys
      const rows = await postgresDb(tx)
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.orderId, orderId), eq(t.keyHash, keyHash)))
        .limit(1)
      return rows.length > 0
    },
  }
}
