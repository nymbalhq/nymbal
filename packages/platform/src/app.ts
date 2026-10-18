import { DEFAULT_JWT_SECRET, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { createPlatform, type Platform, type CreatePlatformOptions } from './platform.js'
import { buildRepositories, type Repositories } from './repositories/index.js'
import { buildAdapters, paymentsAdapterFor, type AdapterRegistry } from './adapters/registry.js'
import { buildServices, type ServiceRegistry } from './services/index.js'
import { createEventPublisher, type EventPublisher } from './events/publisher.js'
import { createRelay, type Relay } from './events/relay.js'
import { registerHandlers } from './handlers/register.js'
import { warmDocumentStore } from './warm-document-store.js'
import {
  startInventoryReservationSweeper,
  startCartAbandonmentSweeper,
  startEventRetentionSweeper,
  type SweeperHandle,
} from './sweepers/index.js'
import type { HttpAdapter } from '@nymbalhq/types'

export interface NymbalApp {
  platform: Platform
  repos: Repositories
  adapters: AdapterRegistry
  services: ServiceRegistry
  publisher: EventPublisher
  /** Delivers the event log to the bus; started by createApp, stopped by stop(). */
  relay: Relay
  attachHttp(adapter: HttpAdapter): Promise<void>
  stop(): Promise<void>
}

export interface CreateAppOptions extends CreatePlatformOptions {
  version?: string
}

/**
 * A production process must not run on the stub payments adapter (its unsigned webhook confirms any order) or sign
 * tokens with the schema's published default secret. Checked before anything opens the store.
 */
function refuseUnsafeProduction(config: NymbalConfig): void {
  if (process.env.NODE_ENV !== 'production') return
  const provider = config.commerce.payments.provider
  if (paymentsAdapterFor(provider) === 'native-stub') {
    throw new ConfigError(
      `Payments provider "${provider}" resolves to the stub adapter, which verifies no webhook signature; ` +
        'configure a real payments provider for production.',
      { code: 'config.production_stub_payments', context: { provider } },
    )
  }
  if (config.security.auth.jwtSecret === DEFAULT_JWT_SECRET) {
    throw new ConfigError(
      'security.auth.jwtSecret is the schema default; set a secret of your own for production.',
      { code: 'config.production_default_jwt_secret' },
    )
  }
}

export async function createApp(
  config: NymbalConfig,
  options: CreateAppOptions = {},
): Promise<NymbalApp> {
  refuseUnsafeProduction(config)
  const platform = createPlatform(config, options)
  const version = options.version ?? '0.1.0'
  const logger = platform.logger

  const repos = buildRepositories(platform.commandStore, platform.documentStore)
  const adapters = await buildAdapters({
    config,
    logger: logger.child({ layer: 'adapter' }),
    documentStore: platform.documentStore,
    repos,
  })
  const relay = createRelay({
    store: platform.commandStore,
    eventLog: repos.eventLog,
    eventBus: platform.eventBus,
    logger,
  })
  const publisher = createEventPublisher({
    eventBus: platform.eventBus,
    store: platform.commandStore,
    eventLog: repos.eventLog,
    relay,
    builderContext: {
      storeId: config.store.name,
      environment:
        process.env.NODE_ENV === 'production'
          ? 'production'
          : process.env.NODE_ENV === 'staging'
            ? 'staging'
            : 'development',
      version,
      source: 'nymbal-app',
    },
  })
  const services = buildServices({
    config,
    store: platform.commandStore,
    repos,
    publisher,
    logger: logger.child({ layer: 'service' }),
    payments: adapters.payments,
    searchAdapter: adapters.search,
  })

  await registerHandlers({
    config,
    eventBus: platform.eventBus,
    documentStore: platform.documentStore,
    repos,
    adapters,
    logger,
  })

  await warmDocumentStore({
    config,
    repos,
    eventBus: platform.eventBus,
    logger,
    version,
  })

  // Events committed before a crash, or whose delivery failed, go out before the app serves anything.
  await relay.drain()
  relay.start()

  const sweepers: SweeperHandle[] = [
    startInventoryReservationSweeper({
      inventoryService: services.inventory,
      reservationRepo: repos.inventoryReservation,
      logger,
    }),
    startCartAbandonmentSweeper({
      store: platform.commandStore,
      carts: repos.cart,
      publisher,
      logger,
    }),
    startEventRetentionSweeper({
      store: platform.commandStore,
      eventLog: repos.eventLog,
      processedEvents: repos.processedEvent,
      logger,
    }),
  ]

  const app: NymbalApp = {
    platform,
    repos,
    adapters,
    services,
    publisher,
    relay,
    async attachHttp(adapter) {
      await adapters.security.applyMiddleware(adapter, config.security)
      const { registerAllRoutes } = await import('./routes/register.js')
      registerAllRoutes({
        config,
        adapter,
        services,
        adapters,
        repos,
        documentStore: platform.documentStore,
        eventBus: platform.eventBus,
        publisher,
      })
    },
    async stop() {
      await relay.stop()
      for (const s of sweepers) s.stop()
      await platform.close()
    },
  }
  return app
}
