import { eq } from 'drizzle-orm'
import { normaliseTrackingNumber } from '@nymbalhq/types'
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

export interface OrderShipmentInput {
  orderId: string
  carrier: string
  trackingNumber: string
  at: Date
}

/** The parcel each shipped order went out in. Each method normalises the tracking number it is given. */
export interface OrderShipmentRepository extends StoreRepository {
  record(tx: Tx, input: OrderShipmentInput): Promise<void>
  /** The ids of every order shipped under the number, in no particular order. */
  ordersByTrackingNumber(tx: ReadTx, trackingNumber: string): Promise<string[]>
}

export function createOrderShipmentRepository(store: CommandStore): OrderShipmentRepository {
  const s = sqliteSchema.orderShipments
  const p = postgresSchema.orderShipments
  return {
    store,
    async record(tx, { orderId, carrier, trackingNumber, at }) {
      const values = { orderId, carrier, trackingNumber: normaliseTrackingNumber(trackingNumber) }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(s)
          .values({ ...values, createdAt: at.toISOString() })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(p)
        .values({ ...values, createdAt: at })
    },
    async ordersByTrackingNumber(tx, trackingNumber) {
      const key = normaliseTrackingNumber(trackingNumber)
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx)
          .select({ orderId: s.orderId })
          .from(s)
          .where(eq(s.trackingNumber, key))
          .all()
          .map((r) => r.orderId)
      }
      const rows = await postgresDb(tx)
        .select({ orderId: p.orderId })
        .from(p)
        .where(eq(p.trackingNumber, key))
      return rows.map((r) => r.orderId)
    },
  }
}
