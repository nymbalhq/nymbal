export type StockAdjustmentReason =
  | 'sale'
  | 'return'
  | 'manual'
  | 'import'
  | 'reservation-commit'
  | 'reservation-release'

export interface InventoryReservation {
  reservationId: string
  variantId: string
  qty: number
  orderRef: string | null
  expiresAt: string
  createdAt: string
}

export interface StockAdjustment {
  id: string
  variantId: string
  adjustment: number
  reason: StockAdjustmentReason
  actor: string
  previousQty: number
  newQty: number
  timestamp: string
}

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock'
