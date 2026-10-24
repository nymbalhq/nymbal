import type { HttpAdapter } from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import type { ServiceRegistry } from '../services/index.js'
import type { Repositories } from '../repositories/index.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import type { EventPublisher } from '../events/publisher.js'
import type { DeclaredSlot } from '../settings/load.js'
import { registerAdminMeRoute } from './admin-me.js'
import { registerAdminDashboardRoute } from './admin-dashboard.js'
import { registerAdminOrdersRoutes } from './admin-orders.js'
import { registerAdminProductsRoutes } from './admin-products.js'
import { registerAdminInventoryRoutes } from './admin-inventory.js'
import { registerAdminCustomersRoutes } from './admin-customers.js'
import { registerAdminSearchRoute } from './admin-search.js'
import { registerAdminReviewsRoutes } from './admin-reviews.js'
import { registerAdminSettingsRoutes } from './admin-settings.js'
import { createHistoryReader } from '../history/read.js'

export interface RegisterAdminRoutesDeps {
  config: NymbalConfig
  services: ServiceRegistry
  repos: Repositories
  adapters: AdapterRegistry
  publisher: EventPublisher
  settingsSlots: readonly DeclaredSlot[]
}

export function registerAdminRoutes(adapter: HttpAdapter, deps: RegisterAdminRoutesDeps): void {
  const { config, services, repos, adapters } = deps
  const history = createHistoryReader({
    eventLog: repos.eventLog,
    auditEntries: repos.auditEntry,
    retentionDays: config.events.retentionDays,
  })

  registerAdminMeRoute(adapter, { config })
  registerAdminDashboardRoute(adapter, { repos, config })
  registerAdminOrdersRoutes(adapter, {
    order: services.order,
    checkout: services.checkout,
    refund: services.refund,
    repos,
    history,
  })
  registerAdminProductsRoutes(adapter, {
    product: services.product,
    ai: adapters.ai,
    history,
  })
  registerAdminInventoryRoutes(adapter, {
    inventory: services.inventory,
    product: services.product,
    repos,
  })
  registerAdminCustomersRoutes(adapter, { order: services.order, repos, history })
  registerAdminSearchRoute(adapter, {
    order: services.order,
    product: services.product,
    repos,
  })
  registerAdminReviewsRoutes(adapter, {
    reviewsAdapter: adapters.reviews,
    reviewRepo: repos.review,
  })
  registerAdminSettingsRoutes(adapter, {
    config,
    slots: deps.settingsSlots,
    settings: repos.settings,
    publisher: deps.publisher,
  })
}
