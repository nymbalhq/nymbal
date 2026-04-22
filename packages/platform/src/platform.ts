import type { NymbalConfig } from '@nymbal/config'
import type { DocumentStoreAdapter, EventBusAdapter, Logger } from '@nymbal/types'
import { createCommandStore, type CommandStore } from './db/command-store.js'
import { createDocumentStore } from './document-store/factory.js'
import { createEventBus } from './event-bus/factory.js'
import { createLogger } from './logger.js'

export interface Platform {
  config: NymbalConfig
  commandStore: CommandStore
  documentStore: DocumentStoreAdapter
  eventBus: EventBusAdapter
  logger: Logger
  close(): Promise<void>
}

export interface CreatePlatformOptions {
  logger?: Logger
  sqlitePath?: string
  postgresUrl?: string
}

export function createPlatform(
  config: NymbalConfig,
  options: CreatePlatformOptions = {},
): Platform {
  const logger =
    options.logger ??
    createLogger({
      base: { store: config.store.name },
    })
  const commandStore = createCommandStore(config, {
    ...(options.sqlitePath !== undefined && { sqlitePath: options.sqlitePath }),
    ...(options.postgresUrl !== undefined && { postgresUrl: options.postgresUrl }),
  })
  const documentStore = createDocumentStore(config)
  const eventBus = createEventBus(config, logger)
  return {
    config,
    commandStore,
    documentStore,
    eventBus,
    logger,
    async close() {
      await commandStore.close()
      await documentStore.close()
      await eventBus.close()
    },
  }
}
