import type { DocumentStoreAdapter } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import { createProductRepository, type ProductRepository } from './product.js'
import { createVariantRepository, type VariantRepository } from './variant.js'
import { createCategoryRepository, type CategoryRepository } from './category.js'
import {
  createProductCategoryRepository,
  type ProductCategoryRepository,
} from './product-category.js'
import { createCustomerRepository, type CustomerRepository } from './customer.js'
import { createRefreshTokenRepository, type RefreshTokenRepository } from './refresh-token.js'
import { createOrderRepository, type OrderRepository } from './order.js'
import { createOrderHistoryRepository, type OrderHistoryRepository } from './order-history.js'
import { createOrderRefundRepository, type OrderRefundRepository } from './order-refund.js'
import { createOrderSequenceRepository, type OrderSequenceRepository } from './order-sequence.js'
import {
  createOrderAccessKeyRepository,
  type OrderAccessKeyRepository,
} from './order-access-key.js'
import {
  createInventoryReservationRepository,
  type InventoryReservationRepository,
} from './inventory-reservation.js'
import {
  createStockAdjustmentRepository,
  type StockAdjustmentRepository,
} from './stock-adjustment.js'
import { createReviewRepository, type ReviewRepository } from './review.js'
import { createProcessedEventRepository, type ProcessedEventRepository } from './processed-event.js'
import { createEventLogRepository, type EventLogRepository } from './event-log.js'
import { createCartRepository, type CartRepository } from './cart.js'
import { createSettingsRepository, type SettingsRepository } from './settings.js'
import { createAuditEntryRepository, type AuditEntryRepository } from './audit-entry.js'
import {
  createAlertSubscriptionRepository,
  type AlertSubscriptionRepository,
} from './alert-subscription.js'
import {
  createEmailSuppressionRepository,
  type EmailSuppressionRepository,
} from './email-suppression.js'

export * from './product.js'
export * from './variant.js'
export * from './category.js'
export * from './product-category.js'
export * from './customer.js'
export * from './refresh-token.js'
export * from './order.js'
export * from './order-history.js'
export * from './order-refund.js'
export * from './order-sequence.js'
export * from './order-access-key.js'
export * from './inventory-reservation.js'
export * from './stock-adjustment.js'
export * from './review.js'
export * from './processed-event.js'
export * from './event-log.js'
export * from './cart.js'
export * from './settings.js'
export * from './audit-entry.js'
export * from './alert-subscription.js'
export * from './email-suppression.js'
export * from './page.js'

export interface Repositories {
  product: ProductRepository
  variant: VariantRepository
  category: CategoryRepository
  productCategory: ProductCategoryRepository
  customer: CustomerRepository
  refreshToken: RefreshTokenRepository
  order: OrderRepository
  orderHistory: OrderHistoryRepository
  orderRefund: OrderRefundRepository
  orderSequence: OrderSequenceRepository
  orderAccessKey: OrderAccessKeyRepository
  inventoryReservation: InventoryReservationRepository
  stockAdjustment: StockAdjustmentRepository
  review: ReviewRepository
  processedEvent: ProcessedEventRepository
  eventLog: EventLogRepository
  cart: CartRepository
  settings: SettingsRepository
  auditEntry: AuditEntryRepository
  alertSubscription: AlertSubscriptionRepository
  emailSuppression: EmailSuppressionRepository
}

export function buildRepositories(
  commandStore: CommandStore,
  // Every repository is command-store backed; the parameter stays so existing callers keep compiling.
  _documentStore: DocumentStoreAdapter,
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
    orderRefund: createOrderRefundRepository(commandStore),
    orderSequence: createOrderSequenceRepository(commandStore),
    orderAccessKey: createOrderAccessKeyRepository(commandStore),
    inventoryReservation: createInventoryReservationRepository(commandStore),
    stockAdjustment: createStockAdjustmentRepository(commandStore),
    review: createReviewRepository(commandStore),
    processedEvent: createProcessedEventRepository(commandStore),
    eventLog: createEventLogRepository(commandStore),
    cart: createCartRepository(commandStore),
    settings: createSettingsRepository(commandStore),
    auditEntry: createAuditEntryRepository(commandStore),
    alertSubscription: createAlertSubscriptionRepository(commandStore),
    emailSuppression: createEmailSuppressionRepository(commandStore),
  }
}
