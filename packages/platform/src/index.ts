export { createPlatform, type Platform, type CreatePlatformOptions } from './platform.js'
export { createCommandStore, type CommandStore } from './db/command-store.js'
export { runMigrations, type MigrateOptions } from './db/migrate.js'
export { createProductRepository, type ProductInsert } from './db/repositories/products.js'
export {
  createCategoryRepository,
  type CategoryInsert,
} from './db/repositories/categories.js'
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
export { createLogger, type CreateLoggerOptions } from './logger.js'
export { runSeed, type SeedDeps, type SeedResult } from './seed/run.js'
export { seedCategories, seedProducts, type SeedCategory, type SeedProduct } from './seed/data.js'
export type { ProductRow, CategoryRow } from './db/schema/index.js'
