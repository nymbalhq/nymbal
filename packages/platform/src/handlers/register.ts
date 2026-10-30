import type { DocumentStoreAdapter, EventBusAdapter, Logger } from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import type { Repositories } from '../repositories/index.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import type { AlertService } from '../services/alert-service.js'
import type { OrderService } from '../services/order-service.js'
import { parseDurationToMs } from '../services/auth-service.js'
import { registerCategoryProjection } from './projections/category-projection.js'
import { registerProductProjection } from './projections/product-projection.js'
import { registerOrderProjection } from './projections/order-projection.js'
import { registerCustomerProjection } from './projections/customer-projection.js'
import { registerInventoryProjection } from './projections/inventory-projection.js'
import { registerRecentlyViewedProjection } from './projections/recently-viewed-projection.js'
import { registerEmailHandler } from './side-effects/email-handler.js'
import { registerSearchHandler } from './side-effects/search-handler.js'
import { registerReviewsHandler } from './side-effects/reviews-handler.js'
import { registerAlertHandler } from './side-effects/alert-handler.js'
import { registerEmailFeedbackHandler } from './side-effects/email-feedback-handler.js'
import { registerShippingTrackingHandler } from './side-effects/shipping-tracking-handler.js'

export interface RegisterHandlersDeps {
  config: NymbalConfig
  eventBus: EventBusAdapter
  documentStore: DocumentStoreAdapter
  repos: Repositories
  adapters: AdapterRegistry
  /** Records each alert's send: the row fired and `alert.sent.v1` published. */
  alerts: AlertService
  /** Moves an order a tracking update reports delivered. */
  orders: OrderService
  logger: Logger
}

export async function registerHandlers(deps: RegisterHandlersDeps): Promise<void> {
  const { config, eventBus, documentStore, repos, adapters, alerts, orders, logger } = deps
  const handlerLogger = logger.child({ component: 'handlers' })

  await registerCategoryProjection({
    eventBus,
    documentStore,
    logger: handlerLogger.child({ projection: 'category' }),
    storeId: config.store.name,
    repos,
  })
  await registerProductProjection({
    eventBus,
    documentStore,
    logger: handlerLogger.child({ projection: 'product' }),
    storeId: config.store.name,
    currency: config.store.currency,
    repos,
  })
  await registerOrderProjection({
    eventBus,
    documentStore,
    logger: handlerLogger.child({ projection: 'order' }),
    orderRepo: repos.order,
    orderHistoryRepo: repos.orderHistory,
  })
  await registerCustomerProjection({
    eventBus,
    documentStore,
    logger: handlerLogger.child({ projection: 'customer' }),
    customerRepo: repos.customer,
    orderRepo: repos.order,
  })
  await registerInventoryProjection({
    eventBus,
    documentStore,
    logger: handlerLogger.child({ projection: 'inventory' }),
    storeId: config.store.name,
    currency: config.store.currency,
    repos,
  })
  await registerRecentlyViewedProjection({
    eventBus,
    documentStore,
    logger: handlerLogger.child({ projection: 'recently-viewed' }),
  })

  await registerEmailHandler({
    eventBus,
    email: adapters.email,
    logger: handlerLogger.child({ handler: 'email' }),
    processedEventRepo: repos.processedEvent,
    orderRepo: repos.order,
    orderAccessKeyRepo: repos.orderAccessKey,
    storeName: config.store.name,
    ...(config.store.url !== undefined && { storeUrl: config.store.url }),
    keyLifetimeMs: parseDurationToMs(config.commerce.orders.keyLifetime.email),
  })
  await registerAlertHandler({
    eventBus,
    email: adapters.email,
    logger: handlerLogger.child({ handler: 'alert' }),
    repos,
    alerts,
    storeName: config.store.name,
  })
  await registerEmailFeedbackHandler({
    eventBus,
    email: adapters.email,
    repos,
    logger: handlerLogger.child({ handler: 'email-feedback' }),
  })
  await registerShippingTrackingHandler({
    eventBus,
    shipping: adapters.shipping,
    repos,
    orderService: orders,
    logger: handlerLogger.child({ handler: 'shipping-tracking' }),
  })
  await registerSearchHandler({
    eventBus,
    search: adapters.search,
    repos,
  })
  await registerReviewsHandler({
    eventBus,
    reviews: adapters.reviews,
    logger: handlerLogger.child({ handler: 'reviews' }),
    processedEventRepo: repos.processedEvent,
  })

  logger.debug('event handlers registered')
}
