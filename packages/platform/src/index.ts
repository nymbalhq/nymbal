export { createPlatform, type Platform, type CreatePlatformOptions } from './platform.js'
export { createCommandStore, type CommandStore, type SqliteClient, type PostgresClient } from './db/command-store.js'
export { runMigrations, type MigrateOptions } from './db/migrate.js'
// Legacy thin repositories (kept for seed + existing consumers).
export {
  createProductRepository as createLegacyProductRepository,
  type ProductInsert as LegacyProductInsert,
  type ProductRow as LegacyProductRow,
} from './db/repositories/products.js'
export {
  createCategoryRepository as createLegacyCategoryRepository,
  type CategoryInsert as LegacyCategoryInsert,
  type CategoryRow as LegacyCategoryRow,
} from './db/repositories/categories.js'
// Full repositories.
export * from './repositories/index.js'
export {
  InMemoryDocumentStore,
  type InMemoryDocumentStoreOptions,
} from './document-store/in-memory.js'
export { createDocumentStore } from './document-store/factory.js'
export {
  InProcessEventBus,
  type InProcessEventBusOptions,
} from './event-bus/in-process.js'
export { createEventBus } from './event-bus/factory.js'
export {
  createEventBuilder,
  type EventBuilderContext,
  type MakeEventOptions,
} from './events/builder.js'
export {
  createEventPublisher,
  type EventPublisher,
  type PublishOptions,
  type CreatePublisherOptions,
} from './events/publisher.js'
export { withIdempotency, type IdempotencyOptions } from './handlers/idempotency.js'
export { registerHandlers, type RegisterHandlersDeps } from './handlers/register.js'
export { registerAllRoutes, type RegisterAllRoutesDeps } from './routes/register.js'
export { createApp, type NymbalApp, type CreateAppOptions } from './app.js'
export {
  startInventoryReservationSweeper,
  startCartAbandonmentSweeper,
  type SweeperHandle,
} from './sweepers/index.js'
export * from './services/index.js'
export * from './adapters/index.js'
export { createLogger, type CreateLoggerOptions } from './logger.js'
export { runSeed, type SeedDeps, type SeedResult } from './seed/run.js'
export { seedCategories, seedProducts, type SeedCategory, type SeedProduct } from './seed/data.js'
