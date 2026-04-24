import type { HttpAdapter } from '@nymbal/types'
import type { NymbalConfig } from '@nymbal/config'
import type { ServiceRegistry } from '../services/index.js'
import type { Repositories } from '../repositories/index.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import { registerAdminMeRoute } from './admin-me.js'
import { registerAdminDashboardRoute } from './admin-dashboard.js'
import { registerAdminOrdersRoutes } from './admin-orders.js'
import { registerAdminProductsRoutes } from './admin-products.js'
import { registerAdminInventoryRoutes } from './admin-inventory.js'
import { registerAdminCustomersRoutes } from './admin-customers.js'
import { registerAdminSearchRoute } from './admin-search.js'
import { registerAdminReviewsRoutes } from './admin-reviews.js'

export interface RegisterAdminRoutesDeps {
  config: NymbalConfig
  services: ServiceRegistry
  repos: Repositories
  adapters: AdapterRegistry
}

export function registerAdminRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminRoutesDeps,
): void {
  const { config, services, repos, adapters } = deps

  registerAdminMeRoute(adapter, { config })
  registerAdminDashboardRoute(adapter, { repos, config })
  registerAdminOrdersRoutes(adapter, { order: services.order, repos })
  registerAdminProductsRoutes(adapter, { product: services.product, ai: adapters.ai })
  registerAdminInventoryRoutes(adapter, {
    inventory: services.inventory,
    product: services.product,
    repos,
  })
  registerAdminCustomersRoutes(adapter, { order: services.order, repos })
  registerAdminSearchRoute(adapter, {
    order: services.order,
    product: services.product,
    repos,
  })
  registerAdminReviewsRoutes(adapter, {
    reviewsAdapter: adapters.reviews,
    reviewRepo: repos.review,
  })
}
