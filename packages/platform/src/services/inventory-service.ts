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
} from '@nymbalhq/types'
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
  reserveStock(
    variantId: string,
    qty: number,
    orderRef?: string | null,
    ttlSeconds?: number,
  ): Promise<ReserveStockResult>
  /** `reserveStock`, answering null instead of throwing when the variant has less than `qty` in stock. */
  tryReserveStock(
    variantId: string,
    qty: number,
    orderRef?: string | null,
    ttlSeconds?: number,
  ): Promise<ReserveStockResult | null>
  releaseReservation(
    reservationId: string,
    reason: 'expired' | 'cancelled' | 'abandoned',
  ): Promise<void>
  commitReservation(reservationId: string, actor: string): Promise<void>
  getStockStatus(
    variantId: string,
  ): Promise<{ stock: number; threshold: number; status: StockStatus }>
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

  async function emitThresholdEvents(
    variantId: string,
    newQty: number,
    threshold: number,
  ): Promise<void> {
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

  /** The conditional decrement and its reservation row; `available` instead when the stock is short. */
  async function take(
    variantId: string,
    qty: number,
    orderRef: string | null,
    ttlSeconds: number | undefined,
  ): Promise<ReserveStockResult | { available: number }> {
    if (qty <= 0) throw new ValidationError(`Reservation qty must be positive, got ${qty}`)
    return store.transaction(async (tx) => {
      const variant = await repos.variant.findById(tx, variantId)
      if (!variant) throw new NotFoundError('variant', variantId)
      const now = new Date()
      const remaining = await repos.variant.decrementStock(tx, variant.id, qty, now)
      if (remaining === null) return { available: variant.stock }
      const expiresAt = new Date(now.getTime() + (ttlSeconds ?? defaultTtl) * 1000)
      const reservationId = uuidv7()
      await repos.inventoryReservation.insert(tx, {
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
        previousQty: remaining + qty,
        newQty: remaining,
        reason: 'manual',
      })
      await emitThresholdEvents(variant.id, remaining, variant.lowStockThreshold)
      return { reservationId, expiresAt: expiresAt.toISOString() }
    })
  }

  return {
    async adjustStock(variantId, delta, reason, actor) {
      return store.transaction(async (tx) => {
        const variant = await repos.variant.findById(tx, variantId)
        if (!variant) throw new NotFoundError('variant', variantId)
        const now = new Date()
        const newQty =
          delta < 0
            ? await repos.variant.decrementStock(tx, variant.id, -delta, now)
            : await repos.variant.incrementStock(tx, variant.id, delta, now)
        if (newQty === null) {
          throw new ValidationError(`Cannot reduce stock below zero (variant ${variantId})`, {
            context: { variantId, stock: variant.stock, delta },
          })
        }
        const previousQty = newQty - delta
        await repos.stockAdjustment.append(tx, {
          id: uuidv7(),
          variantId: variant.id,
          adjustment: delta,
          reason,
          actor,
          previousQty,
          newQty,
          timestamp: now,
        })
        await publisher.publish(EVT_INVENTORY_CHANGED, {
          variantId: variant.id,
          previousQty,
          newQty,
          reason,
        })
        await emitThresholdEvents(variant.id, newQty, variant.lowStockThreshold)
        logger.debug({ variantId, delta, newQty, reason }, 'stock adjusted')
        return { newQty }
      })
    },

    async reserveStock(variantId, qty, orderRef = null, ttlSeconds) {
      const taken = await take(variantId, qty, orderRef, ttlSeconds)
      if ('available' in taken) {
        throw new AdapterError(
          'inventory.insufficient',
          `Insufficient stock for variant ${variantId}`,
          {
            context: { variantId, requested: qty, available: taken.available },
          },
        )
      }
      return taken
    },

    async tryReserveStock(variantId, qty, orderRef = null, ttlSeconds) {
      const taken = await take(variantId, qty, orderRef, ttlSeconds)
      return 'available' in taken ? null : taken
    },

    async releaseReservation(reservationId, reason) {
      await store.transaction(async (tx) => {
        const reservation = await repos.inventoryReservation.deleteById(tx, reservationId)
        if (!reservation) {
          logger.debug(
            { reservationId },
            'reservation already released, committed or never existed',
          )
          return
        }
        const now = new Date()
        const newQty = await repos.variant.incrementStock(
          tx,
          reservation.variantId,
          reservation.qty,
          now,
        )
        if (newQty !== null) {
          const previousQty = newQty - reservation.qty
          await repos.stockAdjustment.append(tx, {
            id: uuidv7(),
            variantId: reservation.variantId,
            adjustment: reservation.qty,
            reason: 'reservation-release',
            actor: `system:release:${reason}`,
            previousQty,
            newQty,
            timestamp: now,
          })
          await publisher.publish(EVT_INVENTORY_CHANGED, {
            variantId: reservation.variantId,
            previousQty,
            newQty,
            reason: 'reservation-release',
          })
        }
        await publisher.publish(EVT_INVENTORY_RELEASED, {
          variantId: reservation.variantId,
          qty: reservation.qty,
          reservationId: reservation.reservationId,
          reason,
        })
      })
    },

    async commitReservation(reservationId, actor) {
      await store.transaction(async (tx) => {
        const reservation = await repos.inventoryReservation.deleteById(tx, reservationId)
        if (!reservation) throw new NotFoundError('reservation', reservationId)
        const variant = await repos.variant.findById(tx, reservation.variantId)
        if (!variant) throw new NotFoundError('variant', reservation.variantId)
        await repos.stockAdjustment.append(tx, {
          id: uuidv7(),
          variantId: variant.id,
          adjustment: -reservation.qty,
          reason: 'reservation-commit',
          actor,
          previousQty: variant.stock + reservation.qty,
          newQty: variant.stock,
          timestamp: new Date(),
        })
        await publisher.publish(EVT_INVENTORY_RELEASED, {
          variantId: reservation.variantId,
          qty: reservation.qty,
          reservationId: reservation.reservationId,
          reason: 'committed',
        })
      })
    },

    async getStockStatus(variantId) {
      const variant = await store.read((tx) => repos.variant.findById(tx, variantId))
      if (!variant) throw new NotFoundError('variant', variantId)
      return {
        stock: variant.stock,
        threshold: variant.lowStockThreshold,
        status: classifyStock(variant.stock, variant.lowStockThreshold),
      }
    },
  }
}
