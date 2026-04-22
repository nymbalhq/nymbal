import { eq, lt } from 'drizzle-orm'
import type { InventoryReservation } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
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

export interface InventoryReservationRepository {
  insert(r: ReservationInsert): Promise<void>
  findById(reservationId: string): Promise<InventoryReservation | null>
  findByVariant(variantId: string): Promise<InventoryReservation[]>
  deleteById(reservationId: string): Promise<void>
  deleteExpiredBefore(cutoff: Date): Promise<InventoryReservation[]>
  setOrderRef(reservationId: string, orderRef: string): Promise<void>
}

export function createInventoryReservationRepository(store: CommandStore): InventoryReservationRepository {
  return {
    async insert(r) {
      if (store.kind === 'sqlite') {
        store.db
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
      await store.db.insert(postgresSchema.inventoryReservations).values({
        reservationId: r.reservationId,
        variantId: r.variantId,
        qty: r.qty,
        orderRef: r.orderRef ?? null,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      })
    },
    async findById(reservationId) {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.inventoryReservations)
          .where(eq(sqliteSchema.inventoryReservations.reservationId, reservationId))
          .get()
        return row ? rowToReservation(row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.inventoryReservations)
        .where(eq(postgresSchema.inventoryReservations.reservationId, reservationId))
      return row ? rowToReservation(row as Record<string, unknown>) : null
    },
    async findByVariant(variantId) {
      if (store.kind === 'sqlite') {
        const rows = store.db
          .select()
          .from(sqliteSchema.inventoryReservations)
          .where(eq(sqliteSchema.inventoryReservations.variantId, variantId))
          .all()
        return rows.map((r) => rowToReservation(r as Record<string, unknown>))
      }
      const rows = await store.db
        .select()
        .from(postgresSchema.inventoryReservations)
        .where(eq(postgresSchema.inventoryReservations.variantId, variantId))
      return rows.map((r) => rowToReservation(r as Record<string, unknown>))
    },
    async deleteById(reservationId) {
      if (store.kind === 'sqlite') {
        store.db
          .delete(sqliteSchema.inventoryReservations)
          .where(eq(sqliteSchema.inventoryReservations.reservationId, reservationId))
          .run()
        return
      }
      await store.db
        .delete(postgresSchema.inventoryReservations)
        .where(eq(postgresSchema.inventoryReservations.reservationId, reservationId))
    },
    async deleteExpiredBefore(cutoff) {
      return store.transaction(async () => {
        if (store.kind === 'sqlite') {
          const rows = store.db
            .select()
            .from(sqliteSchema.inventoryReservations)
            .where(lt(sqliteSchema.inventoryReservations.expiresAt, cutoff.toISOString()))
            .all()
          const out = rows.map((r) => rowToReservation(r as Record<string, unknown>))
          store.db
            .delete(sqliteSchema.inventoryReservations)
            .where(lt(sqliteSchema.inventoryReservations.expiresAt, cutoff.toISOString()))
            .run()
          return out
        }
        const rows = await store.db
          .select()
          .from(postgresSchema.inventoryReservations)
          .where(lt(postgresSchema.inventoryReservations.expiresAt, cutoff))
        const out = rows.map((r) => rowToReservation(r as Record<string, unknown>))
        await store.db
          .delete(postgresSchema.inventoryReservations)
          .where(lt(postgresSchema.inventoryReservations.expiresAt, cutoff))
        return out
      })
    },
    async setOrderRef(reservationId, orderRef) {
      if (store.kind === 'sqlite') {
        store.db
          .update(sqliteSchema.inventoryReservations)
          .set({ orderRef })
          .where(eq(sqliteSchema.inventoryReservations.reservationId, reservationId))
          .run()
        return
      }
      await store.db
        .update(postgresSchema.inventoryReservations)
        .set({ orderRef })
        .where(eq(postgresSchema.inventoryReservations.reservationId, reservationId))
    },
  }
}
