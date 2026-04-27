import type { NymbalConfig } from '@nymbal/config'
import { createPlatform, type Platform, type CreatePlatformOptions } from './platform.js'
import { buildRepositories, type Repositories } from './repositories/index.js'
import { buildAdapters, type AdapterRegistry } from './adapters/registry.js'
import { buildServices, type ServiceRegistry } from './services/index.js'
import { createEventPublisher, type EventPublisher } from './events/publisher.js'
import { registerHandlers } from './handlers/register.js'
import { warmDocumentStore } from './warm-document-store.js'
import {
  startInventoryReservationSweeper,
  startCartAbandonmentSweeper,
  type SweeperHandle,
} from './sweepers/index.js'
import type { HttpAdapter } from '@nymbal/types'

export interface NymbalApp {
  platform: Platform
  repos: Repositories
  adapters: AdapterRegistry
  services: ServiceRegistry
  publisher: EventPublisher
  attachHttp(adapter: HttpAdapter): Promise<void>
  stop(): Promise<void>
}

export interface CreateAppOptions extends CreatePlatformOptions {
  version?: string
}

export async function createApp(
  config: NymbalConfig,
  options: CreateAppOptions = {},
): Promise<NymbalApp> {
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
  const publisher = createEventPublisher({
    eventBus: platform.eventBus,
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
    documentStore: platform.documentStore,
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

  const sweepers: SweeperHandle[] = [
    startInventoryReservationSweeper({
      inventoryService: services.inventory,
      reservationRepo: repos.inventoryReservation,
      logger,
    }),
    startCartAbandonmentSweeper({
      documentStore: platform.documentStore,
      publisher,
      logger,
    }),
  ]

  const app: NymbalApp = {
    platform,
    repos,
    adapters,
    services,
    publisher,
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
      for (const s of sweepers) s.stop()
      await platform.close()
    },
  }
  return app
}
