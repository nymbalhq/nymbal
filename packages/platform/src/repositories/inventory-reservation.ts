import { eq, lt } from 'drizzle-orm'
import type { InventoryReservation } from '@nymbalhq/types'
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

export interface ReservationInsert {
  reservationId: string
  variantId: string
  qty: number
  orderRef?: string | null
  expiresAt: Date
  createdAt: Date
}

function rowToReservation(row: Record<string, unknown>): InventoryReservation {
  return {
    reservationId: String(row.reservationId),
    variantId: String(row.variantId),
    qty: Number(row.qty),
    orderRef: (row.orderRef as string | null) ?? null,
    expiresAt: fromTimestamp(row.expiresAt),
    createdAt: fromTimestamp(row.createdAt),
  }
}

export interface InventoryReservationRepository extends StoreRepository {
  insert(tx: Tx, r: ReservationInsert): Promise<void>
  findById(tx: ReadTx, reservationId: string): Promise<InventoryReservation | null>
  findByVariant(tx: ReadTx, variantId: string): Promise<InventoryReservation[]>
  /** Deletes the reservation and returns the row it removed; null when none was there. Of two concurrent callers
   *  only one gets the row, which is what makes a release and a commit of one reservation exclusive. */
  deleteById(tx: Tx, reservationId: string): Promise<InventoryReservation | null>
  /** Reservations whose expiry is before `at`; deletes nothing. */
  findExpiredBefore(tx: ReadTx, at: Date): Promise<InventoryReservation[]>
  setOrderRef(tx: Tx, reservationId: string, orderRef: string): Promise<void>
}

export function createInventoryReservationRepository(
  store: CommandStore,
): InventoryReservationRepository {
  return {
    store,
    async insert(tx, r) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.inventoryReservations)
          .values({
            reservationId: r.reservationId,
            variantId: r.variantId,
            qty: r.qty,
            orderRef: r.orderRef ?? null,
            expiresAt: r.expiresAt.toISOString(),
            createdAt: r.createdAt.toISOString(),
          })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.inventoryReservations)
        .values({
          reservationId: r.reservationId,
          variantId: r.variantId,
          qty: r.qty,
          orderRef: r.orderRef ?? null,
          expiresAt: r.expiresAt,
          createdAt: r.createdAt,
        })
    },
    async findById(tx, reservationId) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.inventoryReservations)
          .where(eq(sqliteSchema.inventoryReservations.reservationId, reservationId))
          .get()
        return row ? rowToReservation(row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.inventoryReservations)
        .where(eq(postgresSchema.inventoryReservations.reservationId, reservationId))
      return row ? rowToReservation(row as Record<string, unknown>) : null
    },
    async findByVariant(tx, variantId) {
      if (tx.kind === 'sqlite') {
        const rows = sqliteDb(tx)
          .select()
          .from(sqliteSchema.inventoryReservations)
          .where(eq(sqliteSchema.inventoryReservations.variantId, variantId))
          .all()
        return rows.map((r) => rowToReservation(r as Record<string, unknown>))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(postgresSchema.inventoryReservations)
        .where(eq(postgresSchema.inventoryReservations.variantId, variantId))
      return rows.map((r) => rowToReservation(r as Record<string, unknown>))
    },
    async deleteById(tx, reservationId) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .delete(sqliteSchema.inventoryReservations)
          .where(eq(sqliteSchema.inventoryReservations.reservationId, reservationId))
          .returning()
          .get()
        return row ? rowToReservation(row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .delete(postgresSchema.inventoryReservations)
        .where(eq(postgresSchema.inventoryReservations.reservationId, reservationId))
        .returning()
      return row ? rowToReservation(row as Record<string, unknown>) : null
    },
    async findExpiredBefore(tx, at) {
      if (tx.kind === 'sqlite') {
        const rows = sqliteDb(tx)
          .select()
          .from(sqliteSchema.inventoryReservations)
          .where(lt(sqliteSchema.inventoryReservations.expiresAt, at.toISOString()))
          .all()
        return rows.map((r) => rowToReservation(r as Record<string, unknown>))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(postgresSchema.inventoryReservations)
        .where(lt(postgresSchema.inventoryReservations.expiresAt, at))
      return rows.map((r) => rowToReservation(r as Record<string, unknown>))
    },
    async setOrderRef(tx, reservationId, orderRef) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.inventoryReservations)
          .set({ orderRef })
          .where(eq(sqliteSchema.inventoryReservations.reservationId, reservationId))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.inventoryReservations)
        .set({ orderRef })
        .where(eq(postgresSchema.inventoryReservations.reservationId, reservationId))
    },
  }
}
