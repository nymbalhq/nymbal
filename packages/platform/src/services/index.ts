import type {
  DocumentStoreAdapter,
  Logger,
  PaymentsAdapter,
  SearchAdapter,
} from '@nymbal/types'
import type { NymbalConfig } from '@nymbal/config'
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
import { createCheckoutService, type CheckoutService } from './checkout-service.js'
import { createSearchService, type SearchService } from './search-service.js'

export * from './product-service.js'
export * from './category-service.js'
export * from './cart-service.js'
export * from './customer-service.js'
export * from './auth-service.js'
export * from './order-service.js'
export * from './inventory-service.js'
export * from './checkout-service.js'
export * from './search-service.js'

export interface ServiceRegistry {
  product: ProductService
  category: CategoryService
  cart: CartService
  customer: CustomerService
  auth: AuthService
  order: OrderService
  inventory: InventoryService
  checkout: CheckoutService
  search: SearchService
}

export interface BuildServicesDeps {
  config: NymbalConfig
  store: CommandStore
  repos: Repositories
  documentStore: DocumentStoreAdapter
  publisher: EventPublisher
  logger: Logger
  payments: PaymentsAdapter
  searchAdapter: SearchAdapter
}

export function buildServices(deps: BuildServicesDeps): ServiceRegistry {
  const { config, store, repos, documentStore, publisher, logger, payments, searchAdapter } = deps
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
    documentStore,
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
    documentStore,
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
    search: createSearchService({
      adapter: searchAdapter,
      logger: logger.child({ service: 'search' }),
    }),
  }
}
