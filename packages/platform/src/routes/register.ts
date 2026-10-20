import type { HttpAdapter, DocumentStoreAdapter, EventBusAdapter } from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import type { ServiceRegistry } from '../services/index.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'
import { createAuthMiddleware } from './auth-middleware.js'
import { registerAuthRoutes } from './auth.js'
import { registerProductRoutes } from './products.js'
import { registerCapabilitiesRoute } from './capabilities.js'
import { registerCategoryRoutes } from './categories.js'
import { registerCartRoutes } from './cart.js'
import { registerCheckoutRoutes } from './checkout.js'
import { registerOrderRoutes } from './orders.js'
import { registerCustomerRoutes } from './customers.js'
import { registerAdminRoutes } from './admin.js'
import { registerAdminStaticRoute } from './admin-static.js'
import { registerEventsSseRoute } from './events-sse.js'
import { registerStripeWebhookRoute } from './webhooks-stripe.js'
import { validatedAdapter } from './validated-adapter.js'

export interface RegisterAllRoutesDeps {
  config: NymbalConfig
  adapter: HttpAdapter
  services: ServiceRegistry
  adapters: AdapterRegistry
  repos: Repositories
  documentStore: DocumentStoreAdapter
  eventBus: EventBusAdapter
  publisher: EventPublisher
  /** The admin's dist directory, or null for a 404 that says how to build it; undefined serves no admin. */
  adminRoot?: string | null | undefined
}

export function registerAllRoutes(deps: RegisterAllRoutesDeps): void {
  const { config, services, adapters, repos, documentStore, eventBus, publisher } = deps
  const adapter = validatedAdapter(deps.adapter)

  // Auth middleware — decodes bearer if present.
  adapter.registerMiddleware(createAuthMiddleware(services.auth))

  registerAuthRoutes(adapter, services.auth)
  registerCapabilitiesRoute(adapter, adapters)
  registerCategoryRoutes(adapter, documentStore, config.store.name)
  registerProductRoutes(
    adapter,
    documentStore,
    config.store.name,
    adapters.reviews,
    services.search,
    () => adapters.search.capabilities().includes('facet'),
  )
  registerCartRoutes(adapter, {
    cart: services.cart,
    productRepo: repos.product,
    variantRepo: repos.variant,
  })
  registerCheckoutRoutes(adapter, services.checkout)
  registerOrderRoutes(adapter, services.order, documentStore)
  registerCustomerRoutes(adapter, services.customer)
  registerAdminRoutes(adapter, {
    config,
    services,
    repos,
    adapters,
  })
  registerEventsSseRoute(adapter, {
    eventBus,
    documentStore,
    ticketSecret: config.security.auth.jwtSecret,
  })
  registerStripeWebhookRoute(adapter, {
    payments: adapters.payments,
    checkout: services.checkout,
    publisher,
    store: repos.processedEvent.store,
    processedEvents: repos.processedEvent,
    orders: repos.order,
  })
  if (deps.adminRoot !== undefined) registerAdminStaticRoute(adapter, deps.adminRoot)
}
