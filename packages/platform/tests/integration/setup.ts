import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../src/event-bus/in-process.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { buildRepositories } from '../../src/repositories/index.js'
import { createEventPublisher, createRelay } from '../../src/index.js'
import { wirePublisher } from '../../src/tests/publisher.js'
import { createProductService } from '../../src/services/product-service.js'
import { createInventoryService } from '../../src/services/inventory-service.js'
import { createOrderService } from '../../src/services/order-service.js'
import { createCartService } from '../../src/services/cart-service.js'
import { createCheckoutService } from '../../src/services/checkout-service.js'
import { createAuthService } from '../../src/services/auth-service.js'
import { createCategoryService } from '../../src/services/category-service.js'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { createLogger } from '../../src/logger.js'

export async function createTestEnv() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config for tests
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, documentStore)
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
  const payments = createNativeStubPaymentsAdapter({ logger })

  const product = createProductService({
    store: commandStore,
    repos,
    publisher,
    logger,
    currency: 'GBP',
  })
  const inventory = createInventoryService({ store: commandStore, repos, publisher, logger })
  const order = createOrderService({
    store: commandStore,
    repos,
    publisher,
    logger,
    orderNumberPrefix: 'INT',
    orderNumberStart: 1,
  })
  const cart = createCartService({
    store: commandStore,
    carts: repos.cart,
    publisher,
    logger,
    currency: 'GBP',
  })
  const checkout = createCheckoutService({
    store: commandStore,
    repos,
    publisher,
    logger,
    cart,
    orders: order,
    inventory,
    payments,
    currency: 'GBP',
  })
  const auth = createAuthService({
    repos,
    publisher,
    logger,
    jwtSecret: 'integration-test-secret-32ch-x',
    accessTtl: '15m',
    refreshTtl: '7d',
  })
  const category = createCategoryService({ repos, publisher, logger })

  return {
    commandStore,
    documentStore,
    eventBus,
    repos,
    publisher,
    product,
    inventory,
    order,
    cart,
    checkout,
    auth,
    category,
  }
}

export const testAddr = {
  firstName: 'Alice',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}
