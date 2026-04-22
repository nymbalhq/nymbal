import type { DocumentStoreAdapter } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
import { createProductRepository, type ProductRepository } from './product.js'
import { createVariantRepository, type VariantRepository } from './variant.js'
import { createCategoryRepository, type CategoryRepository } from './category.js'
import { createProductCategoryRepository, type ProductCategoryRepository } from './product-category.js'
import { createCustomerRepository, type CustomerRepository } from './customer.js'
import { createRefreshTokenRepository, type RefreshTokenRepository } from './refresh-token.js'
import { createOrderRepository, type OrderRepository } from './order.js'
import { createOrderHistoryRepository, type OrderHistoryRepository } from './order-history.js'
import { createOrderSequenceRepository, type OrderSequenceRepository } from './order-sequence.js'
import { createInventoryReservationRepository, type InventoryReservationRepository } from './inventory-reservation.js'
import { createStockAdjustmentRepository, type StockAdjustmentRepository } from './stock-adjustment.js'
import { createReviewRepository, type ReviewRepository } from './review.js'
import { createProcessedEventRepository, type ProcessedEventRepository } from './processed-event.js'

export * from './product.js'
export * from './variant.js'
export * from './category.js'
export * from './product-category.js'
export * from './customer.js'
export * from './refresh-token.js'
export * from './order.js'
export * from './order-history.js'
export * from './order-sequence.js'
export * from './inventory-reservation.js'
export * from './stock-adjustment.js'
export * from './review.js'
export * from './processed-event.js'

export interface Repositories {
  product: ProductRepository
  variant: VariantRepository
  category: CategoryRepository
  productCategory: ProductCategoryRepository
  customer: CustomerRepository
  refreshToken: RefreshTokenRepository
  order: OrderRepository
  orderHistory: OrderHistoryRepository
  orderSequence: OrderSequenceRepository
  inventoryReservation: InventoryReservationRepository
  stockAdjustment: StockAdjustmentRepository
  review: ReviewRepository
  processedEvent: ProcessedEventRepository
}

export function buildRepositories(
  commandStore: CommandStore,
  documentStore: DocumentStoreAdapter,
): Repositories {
  return {
    product: createProductRepository(commandStore),
    variant: createVariantRepository(commandStore),
    category: createCategoryRepository(commandStore),
    productCategory: createProductCategoryRepository(commandStore),
    customer: createCustomerRepository(commandStore),
    refreshToken: createRefreshTokenRepository(commandStore),
    order: createOrderRepository(commandStore),
    orderHistory: createOrderHistoryRepository(commandStore),
    orderSequence: createOrderSequenceRepository(commandStore),
    inventoryReservation: createInventoryReservationRepository(commandStore),
    stockAdjustment: createStockAdjustmentRepository(commandStore),
    review: createReviewRepository(commandStore),
    processedEvent: createProcessedEventRepository(documentStore),
  }
}
