import type { InventoryReservation, StockAdjustment, StockAdjustmentReason } from '@nymbal/types'
import { nextId, isoDate, randInt } from './prng.js'

export function createInventoryReservation(
  overrides?: Partial<InventoryReservation>,
): InventoryReservation {
  return {
    reservationId: nextId(),
    variantId: nextId(),
    qty: randInt(1, 5),
    orderRef: null,
    expiresAt: isoDate(1),
    createdAt: isoDate(),
    ...overrides,
  }
}

export function createStockAdjustment(overrides?: Partial<StockAdjustment>): StockAdjustment {
  const previous = randInt(0, 100)
  const adjustment = randInt(-10, 10)
  return {
    id: nextId(),
    variantId: nextId(),
    adjustment,
    reason: 'manual' as StockAdjustmentReason,
    actor: 'system',
    previousQty: previous,
    newQty: previous + adjustment,
    timestamp: isoDate(),
    ...overrides,
  }
}
