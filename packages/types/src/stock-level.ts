export type StockLevel = 'out' | 'low' | 'in'

/** Below this many units a variant is low on stock. */
const LOW_STOCK_BELOW = 5

/** The one stock rule every storefront renders from. */
export function stockLevel(stock: number): StockLevel {
  if (stock <= 0) return 'out'
  return stock < LOW_STOCK_BELOW ? 'low' : 'in'
}

export const STOCK_LABELS: Record<StockLevel, string> = {
  out: 'Out of Stock',
  low: 'Low Stock',
  in: 'In Stock',
}
