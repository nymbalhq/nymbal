import {
  ConfigError,
  type HttpAdapter,
  type DocumentStoreAdapter,
  type EventBusAdapter,
} from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import type { ServiceRegistry } from '../services/index.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'
import type { DeclaredSlot } from '../settings/load.js'
import { runWithCorrelation } from '../events/correlation.js'
import type { CommandStore } from '../db/command-store.js'
import { actorOf, runAsActor } from '../audit/actor.js'
import {
  auditedRoute,
  idempotencyKeyOf,
  idempotentCommand,
  malformedKey,
  requestHash,
} from '../audit/idempotency.js'
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
import { routeSchemas } from './schemas.js'
import { registerAdminActivityRoutes } from './admin-activity.js'
import { registerAlertRoutes } from './alerts.js'

export interface RegisterAllRoutesDeps {
  config: NymbalConfig
  adapter: HttpAdapter
  services: ServiceRegistry
  adapters: AdapterRegistry
  repos: Repositories
  documentStore: DocumentStoreAdapter
  eventBus: EventBusAdapter
  publisher: EventPublisher
  /** The slots whose provider packages declare settings, as the store booted with them. */
  settingsSlots: readonly DeclaredSlot[]
  /** The admin's dist directory, or null for a 404 that says how to build it; undefined serves no admin. */
  adminRoot?: string | null | undefined
}

/** Every handler runs in its request's correlation scope, so each event a route's services publish carries its id. */
function correlatedAdapter(adapter: HttpAdapter): HttpAdapter {
  return {
    registerRoute(method, path, handler, options) {
      adapter.registerRoute(
        method,
        path,
        (ctx) => runWithCorrelation(ctx.correlationId, () => handler(ctx)),
        options,
      )
    },
    registerStreamRoute(method, path, handler, options) {
      adapter.registerStreamRoute(
        method,
        path,
        (ctx, stream) => runWithCorrelation(ctx.correlationId, () => handler(ctx, stream)),
        options,
      )
    },
    registerMiddleware: (middleware) => adapter.registerMiddleware(middleware),
    setDefaultHeaders: (headers) => adapter.setDefaultHeaders(headers),
    start: (port, host) => adapter.start(port, host),
    stop: () => adapter.stop(),
  }
}

/** The audit command a route declares: undefined for a GET, else its name or null (it changes nothing audited). */
function commandOf(method: string, path: string): string | null | undefined {
  const schema = routeSchemas[`${method} ${path}`]
  // A route with no schema at all stops startup in validatedAdapter.
  if (method === 'GET' || schema === undefined) return undefined
  const { command } = schema
  if (command === undefined) {
    throw new ConfigError(`route ${method} ${path} declares no audit command in routeSchemas`, {
      code: 'config.route_command_missing',
      context: { method, path },
    })
  }
  return command
}

/**
 * Every handler runs as its request's actor. A route that runs a command runs it as one audited command; an admin
 * write with an `Idempotency-Key` runs once per key (a malformed key is refused before anything runs). It wraps each
 * handler before `validatedAdapter` does, so the schema runs first and a request it refuses never reaches a command.
 */
function auditedAdapter(adapter: HttpAdapter, store: CommandStore): HttpAdapter {
  return {
    registerRoute(method, path, handler, options) {
      const command = commandOf(method, path)
      const adminWrite = command !== undefined && path.startsWith('/api/admin/')
      const provider = routeSchemas[`${method} ${path}`]?.provider === true
      adapter.registerRoute(
        method,
        path,
        (ctx) => {
          const actor = actorOf(ctx.auth)
          return runAsActor(actor, async () => {
            const keyed = adminWrite ? idempotencyKeyOf(ctx) : { key: undefined }
            if ('malformed' in keyed) return malformedKey()
            if (!command) return handler(ctx)
            const run = async () => handler(ctx)
            if (keyed.key === undefined) return auditedRoute(store, command, run)
            return idempotentCommand(
              store,
              command,
              { actor, key: keyed.key, hash: requestHash(ctx), provider },
              run,
            )
          })
        },
        options,
      )
    },
    registerStreamRoute(method, path, handler, options) {
      adapter.registerStreamRoute(
        method,
        path,
        (ctx, stream) => runAsActor(actorOf(ctx.auth), () => handler(ctx, stream)),
        options,
      )
    },
    registerMiddleware: (middleware) => adapter.registerMiddleware(middleware),
    setDefaultHeaders: (headers) => adapter.setDefaultHeaders(headers),
    start: (port, host) => adapter.start(port, host),
    stop: () => adapter.stop(),
  }
}

export function registerAllRoutes(deps: RegisterAllRoutesDeps): void {
  const { config, services, adapters, repos, documentStore, eventBus, publisher } = deps
  const adapter = auditedAdapter(
    validatedAdapter(correlatedAdapter(deps.adapter)),
    repos.auditEntry.store,
  )

  // Auth middleware — decodes bearer if present.
  adapter.registerMiddleware(createAuthMiddleware(services.auth))

  registerAuthRoutes(adapter, services.auth, config.security.auth.refreshTtl)
  registerCapabilitiesRoute(adapter, adapters)
  registerCategoryRoutes(adapter, documentStore, config.store.name)
  registerProductRoutes(
    adapter,
    documentStore,
    config.store.name,
    adapters.reviews,
    services.search,
    () => adapters.search.capabilities().includes('facet'),
    (field, params) => adapters.search.facet(field, params),
  )
  registerCartRoutes(adapter, {
    cart: services.cart,
    productRepo: repos.product,
    variantRepo: repos.variant,
  })
  registerCheckoutRoutes(adapter, services.checkout)
  registerAlertRoutes(adapter, { alerts: services.alert })
  registerOrderRoutes(adapter, services.order, documentStore)
  registerCustomerRoutes(adapter, services.customer)
  registerAdminRoutes(adapter, {
    config,
    services,
    repos,
    adapters,
    publisher,
    settingsSlots: deps.settingsSlots,
  })
  registerAdminActivityRoutes(adapter, { auditEntries: repos.auditEntry })
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
