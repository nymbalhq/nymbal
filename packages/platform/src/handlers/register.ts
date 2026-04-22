import type { DocumentStoreAdapter, EventBusAdapter, Logger } from '@nymbal/types'
import type { NymbalConfig } from '@nymbal/config'
import type { Repositories } from '../repositories/index.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import { registerProductProjection } from './projections/product-projection.js'
import { registerOrderProjection } from './projections/order-projection.js'
import { registerCustomerProjection } from './projections/customer-projection.js'
import { registerInventoryProjection } from './projections/inventory-projection.js'
import { registerEmailHandler } from './side-effects/email-handler.js'
import { registerSearchHandler } from './side-effects/search-handler.js'
import { registerReviewsHandler } from './side-effects/reviews-handler.js'

export interface RegisterHandlersDeps {
  config: NymbalConfig
  eventBus: EventBusAdapter
  documentStore: DocumentStoreAdapter
  repos: Repositories
  adapters: AdapterRegistry
  logger: Logger
}

export async function registerHandlers(deps: RegisterHandlersDeps): Promise<void> {
  const { config, eventBus, documentStore, repos, adapters, logger } = deps
  const handlerLogger = logger.child({ component: 'handlers' })

  await registerProductProjection({
    eventBus,
    documentStore,
    logger: handlerLogger.child({ projection: 'product' }),
    storeId: config.store.name,
    currency: config.store.currency,
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
    variantRepo: repos.variant,
    productRepo: repos.product,
    productCategoryRepo: repos.productCategory,
  })

  await registerEmailHandler({
    eventBus,
    email: adapters.email,
    logger: handlerLogger.child({ handler: 'email' }),
    processedEventRepo: repos.processedEvent,
    storeName: config.store.name,
  })
  await registerSearchHandler({
    eventBus,
    search: adapters.search,
    logger: handlerLogger.child({ handler: 'search' }),
    processedEventRepo: repos.processedEvent,
  })
  await registerReviewsHandler({
    eventBus,
    reviews: adapters.reviews,
    logger: handlerLogger.child({ handler: 'reviews' }),
    processedEventRepo: repos.processedEvent,
  })

  logger.info('event handlers registered')
}
