import type { PaymentClient } from './adapters/commerce.js'
import type { ProductSortKey } from './domain/product.js'

/**
 * What GET /api/capabilities tells a storefront about the store: what its adapters can do, never which vendor they
 * are. It names no provider and holds no secret.
 */
export interface StoreCapabilities {
  payments: { capabilities: string[]; client: PaymentClient | null }
  search: { capabilities: string[] }
  /** The listing orders GET /api/products accepts, in display order, and the one it uses when none is asked. */
  catalog: { sortKeys: ProductSortKey[]; defaultSort: ProductSortKey }
  /** Whether the store's email reaches a mailbox: false when its adapter only logs (`native`). */
  email: { delivers: boolean }
}
