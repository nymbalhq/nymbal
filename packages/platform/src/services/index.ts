import type { EmailAdapter, Logger, PaymentsAdapter, SearchAdapter } from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import type { CommandStore } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'
import { createProductService, type ProductService } from './product-service.js'
import { createCategoryService, type CategoryService } from './category-service.js'
import { createCartService, type CartService } from './cart-service.js'
import { createCustomerService, type CustomerService } from './customer-service.js'
import { createAuthService, type AuthService } from './auth-service.js'
import { createOrderService, type OrderService } from './order-service.js'
import { createInventoryService, type InventoryService } from './inventory-service.js'
import {
  createCheckoutService,
  type CheckoutService,
  type ManualPayments,
} from './checkout-service.js'
import { createSearchService, type SearchService } from './search-service.js'
import { createRefundService, type RefundService } from './refund-service.js'
import {
  createRecentlyViewedService,
  type RecentlyViewedService,
} from './recently-viewed-service.js'
import { createAlertService, type AlertService } from './alert-service.js'

export * from './product-service.js'
export * from './category-service.js'
export * from './cart-service.js'
export * from './customer-service.js'
export * from './auth-service.js'
export * from './order-service.js'
export * from './inventory-service.js'
export * from './checkout-service.js'
export * from './search-service.js'
export * from './refund-service.js'
export * from './recently-viewed-service.js'
export * from './alert-service.js'
export { newAlertToken } from './alert-token.js'

/** A `native` email adapter only logs; any other (`smtp`, a project's own) is taken to reach a mailbox. */
export function emailDelivers(email: EmailAdapter): boolean {
  return email.providerName !== 'native'
}

export interface ServiceRegistry {
  product: ProductService
  category: CategoryService
  cart: CartService
  customer: CustomerService
  auth: AuthService
  order: OrderService
  inventory: InventoryService
  checkout: CheckoutService & ManualPayments
  refund: RefundService
  search: SearchService
  recentlyViewed: RecentlyViewedService
  alert: AlertService
}

export interface BuildServicesDeps {
  config: NymbalConfig
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
  payments: PaymentsAdapter
  searchAdapter: SearchAdapter
  email: EmailAdapter
}

export function buildServices(deps: BuildServicesDeps): ServiceRegistry {
  const { config, store, repos, publisher, logger, payments, searchAdapter, email } = deps
  const inventory = createInventoryService({
    store,
    repos,
    publisher,
    logger: logger.child({ service: 'inventory' }),
  })
  const orders = createOrderService({
    store,
    repos,
    publisher,
    logger: logger.child({ service: 'order' }),
    orderNumberPrefix: config.commerce.orders.numberPrefix,
    orderNumberStart: config.commerce.orders.numberStart,
  })
  const cart = createCartService({
    store,
    carts: repos.cart,
    publisher,
    logger: logger.child({ service: 'cart' }),
    currency: config.store.currency,
  })
  const checkout = createCheckoutService({
    store,
    repos,
    publisher,
    logger: logger.child({ service: 'checkout' }),
    cart,
    orders,
    inventory,
    payments,
    currency: config.store.currency,
  })
  return {
    product: createProductService({
      store,
      repos,
      publisher,
      logger: logger.child({ service: 'product' }),
    }),
    category: createCategoryService({
      repos,
      publisher,
      logger: logger.child({ service: 'category' }),
    }),
    cart,
    customer: createCustomerService({
      repos,
      publisher,
      logger: logger.child({ service: 'customer' }),
    }),
    auth: createAuthService({
      repos,
      publisher,
      logger: logger.child({ service: 'auth' }),
      jwtSecret: config.security.auth.jwtSecret,
      accessTtl: config.security.auth.accessTtl,
      refreshTtl: config.security.auth.refreshTtl,
    }),
    order: orders,
    inventory,
    checkout,
    refund: createRefundService({
      store,
      repos,
      publisher,
      logger: logger.child({ service: 'refund' }),
      payments,
    }),
    search: createSearchService({
      adapter: searchAdapter,
      logger: logger.child({ service: 'search' }),
    }),
    recentlyViewed: createRecentlyViewedService({
      store,
      repos,
      publisher,
      logger: logger.child({ service: 'recently-viewed' }),
    }),
    alert: createAlertService({
      store,
      repos,
      publisher,
      allowedOrigins: config.http.cors.allowedOrigins,
      delivers: () => emailDelivers(email),
    }),
  }
}
