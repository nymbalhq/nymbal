import { v7 as uuidv7 } from 'uuid'
import {
  AdapterError,
  NotFoundError,
  ValidationError,
  EVT_INVENTORY_CHANGED,
  EVT_INVENTORY_RESERVED,
  EVT_INVENTORY_RELEASED,
  EVT_INVENTORY_LOW_STOCK,
  EVT_INVENTORY_OUT_OF_STOCK,
  type Logger,
  type StockAdjustmentReason,
  type StockStatus,
} from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'

export interface ReserveStockResult {
  reservationId: string
  expiresAt: string
}

export interface InventoryService {
  adjustStock(
    variantId: string,
    delta: number,
    reason: StockAdjustmentReason,
    actor: string,
  ): Promise<{ newQty: number }>
  reserveStock(variantId: string, qty: number, orderRef?: string | null, ttlSeconds?: number): Promise<ReserveStockResult>
  releaseReservation(reservationId: string, reason: 'expired' | 'cancelled' | 'abandoned'): Promise<void>
  commitReservation(reservationId: string, actor: string): Promise<void>
  getStockStatus(variantId: string): Promise<{ stock: number; threshold: number; status: StockStatus }>
}

export interface CreateInventoryServiceDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
  defaultReservationTtlSeconds?: number
}

function classifyStock(stock: number, threshold: number): StockStatus {
  if (stock <= 0) return 'out_of_stock'
  if (stock <= threshold) return 'low_stock'
  return 'in_stock'
}

export function createInventoryService(deps: CreateInventoryServiceDeps): InventoryService {
  const { store, repos, publisher, logger } = deps
  const defaultTtl = deps.defaultReservationTtlSeconds ?? 15 * 60

  async function emitThresholdEvents(variantId: string, newQty: number, threshold: number): Promise<void> {
    if (newQty <= 0) {
      await publisher.publish(EVT_INVENTORY_OUT_OF_STOCK, { variantId })
    } else if (newQty <= threshold) {
      await publisher.publish(EVT_INVENTORY_LOW_STOCK, {
        variantId,
        currentQty: newQty,
        threshold,
      })
    }
  }

  return {
    async adjustStock(variantId, delta, reason, actor) {
      return store.transaction(async () => {
        const variant = await repos.variant.findById(variantId)
        if (!variant) throw new NotFoundError('variant', variantId)
        const newQty = variant.stock + delta
        if (newQty < 0) {
          throw new ValidationError(`Cannot reduce stock below zero (variant ${variantId})`, {
            context: { variantId, stock: variant.stock, delta },
          })
        }
        const now = new Date()
        await repos.variant.setStock(variant.id, newQty, now)
        await repos.stockAdjustment.append({
          id: uuidv7(),
          variantId: variant.id,
          adjustment: delta,
          reason,
          actor,
          previousQty: variant.stock,
          newQty,
          timestamp: now,
        })
        await publisher.publish(EVT_INVENTORY_CHANGED, {
          variantId: variant.id,
          previousQty: variant.stock,
          newQty,
          reason,
        })
        await emitThresholdEvents(variant.id, newQty, variant.lowStockThreshold)
        logger.debug({ variantId, delta, newQty, reason }, 'stock adjusted')
        return { newQty }
      })
    },

    async reserveStock(variantId, qty, orderRef = null, ttlSeconds) {
      if (qty <= 0) throw new ValidationError(`Reservation qty must be positive, got ${qty}`)
      return store.transaction(async () => {
        const variant = await repos.variant.findById(variantId)
        if (!variant) throw new NotFoundError('variant', variantId)
        if (variant.stock < qty) {
          throw new AdapterError('inventory.insufficient', `Insufficient stock for variant ${variantId}`, {
            context: { variantId, requested: qty, available: variant.stock },
          })
        }
        const now = new Date()
        const expiresAt = new Date(now.getTime() + (ttlSeconds ?? defaultTtl) * 1000)
        const reservationId = uuidv7()
        const newQty = variant.stock - qty
        await repos.variant.setStock(variant.id, newQty, now)
        await repos.inventoryReservation.insert({
          reservationId,
          variantId: variant.id,
          qty,
          orderRef,
          expiresAt,
          createdAt: now,
        })
        await publisher.publish(EVT_INVENTORY_RESERVED, {
          variantId: variant.id,
          qty,
          reservationId,
          expiresAt: expiresAt.toISOString(),
        })
        await publisher.publish(EVT_INVENTORY_CHANGED, {
          variantId: variant.id,
          previousQty: variant.stock,
          newQty,
          reason: 'manual',
        })
        await emitThresholdEvents(variant.id, newQty, variant.lowStockThreshold)
        return { reservationId, expiresAt: expiresAt.toISOString() }
      })
    },

    async releaseReservation(reservationId, reason) {
      await store.transaction(async () => {
        const reservation = await repos.inventoryReservation.findById(reservationId)
        if (!reservation) {
          logger.debug({ reservationId }, 'reservation already released or never existed')
          return
        }
        const variant = await repos.variant.findById(reservation.variantId)
        if (variant) {
          const now = new Date()
          const newQty = variant.stock + reservation.qty
          await repos.variant.setStock(variant.id, newQty, now)
          await repos.stockAdjustment.append({
            id: uuidv7(),
            variantId: variant.id,
            adjustment: reservation.qty,
            reason: 'reservation-release',
            actor: `system:release:${reason}`,
            previousQty: variant.stock,
            newQty,
            timestamp: now,
          })
          await publisher.publish(EVT_INVENTORY_CHANGED, {
            variantId: variant.id,
            previousQty: variant.stock,
            newQty,
            reason: 'reservation-release',
          })
        }
        await repos.inventoryReservation.deleteById(reservation.reservationId)
        await publisher.publish(EVT_INVENTORY_RELEASED, {
          variantId: reservation.variantId,
          qty: reservation.qty,
          reservationId: reservation.reservationId,
          reason,
        })
      })
    },

    async commitReservation(reservationId, actor) {
      await store.transaction(async () => {
        const reservation = await repos.inventoryReservation.findById(reservationId)
        if (!reservation) throw new NotFoundError('reservation', reservationId)
        const variant = await repos.variant.findById(reservation.variantId)
        if (!variant) throw new NotFoundError('variant', reservation.variantId)
        const now = new Date()
        await repos.stockAdjustment.append({
          id: uuidv7(),
          variantId: variant.id,
          adjustment: -reservation.qty,
          reason: 'reservation-commit',
          actor,
          previousQty: variant.stock + reservation.qty,
          newQty: variant.stock,
          timestamp: now,
        })
        await repos.inventoryReservation.deleteById(reservation.reservationId)
        await publisher.publish(EVT_INVENTORY_RELEASED, {
          variantId: reservation.variantId,
          qty: reservation.qty,
          reservationId: reservation.reservationId,
          reason: 'committed',
        })
      })
    },

    async getStockStatus(variantId) {
      const variant = await repos.variant.findById(variantId)
      if (!variant) throw new NotFoundError('variant', variantId)
      return {
        stock: variant.stock,
        threshold: variant.lowStockThreshold,
        status: classifyStock(variant.stock, variant.lowStockThreshold),
      }
    },
  }
}
