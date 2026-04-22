export { createPlatform } from './platform.js';
export { createCommandStore } from './db/command-store.js';
export { runMigrations } from './db/migrate.js';
export { createProductRepository } from './db/repositories/products.js';
export { createCategoryRepository, } from './db/repositories/categories.js';
export { InMemoryDocumentStore, } from './document-store/in-memory.js';
export { createDocumentStore } from './document-store/factory.js';
export { InProcessEventBus, } from './event-bus/in-process.js';
export { createEventBus } from './event-bus/factory.js';
export { createEventBuilder, } from './events/builder.js';
export { createLogger } from './logger.js';
export { runSeed } from './seed/run.js';
export { seedCategories, seedProducts } from './seed/data.js';
//# sourceMappingURL=index.js.map