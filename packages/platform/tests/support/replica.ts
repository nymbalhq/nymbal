import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../src/event-bus/in-process.js'
import { createCommandStore, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { buildRepositories, type Repositories } from '../../src/repositories/index.js'
import { createEventPublisher, createRelay } from '../../src/index.js'
import { wirePublisher } from '../../src/tests/publisher.js'
import type { EventPublisher } from '../../src/events/publisher.js'
import { createProductService, type ProductService } from '../../src/services/product-service.js'
import {
  createInventoryService,
  type InventoryService,
} from '../../src/services/inventory-service.js'
import { createOrderService, type OrderService } from '../../src/services/order-service.js'
import { createCartService, type CartService } from '../../src/services/cart-service.js'
import { createCheckoutService, type CheckoutService } from '../../src/services/checkout-service.js'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { startCartAbandonmentSweeper, type SweeperHandle } from '../../src/sweepers/index.js'
import { createLogger } from '../../src/logger.js'
import { kernelConfig, MIGRATIONS_ROOT, type Dialect } from './kernel.js'

// One API replica's worth of kernel on a database the caller owns, without createApp (no relay loop, no sweepers, no
// projections): a command store, its repositories, an outbox publisher and the services the cart tests drive, all on
// a clock the test moves. Several replicas on one target are several processes on one database.

export interface Clock {
  now(): Date
  set(at: Date): void
  advance(ms: number): void
}

export function clockAt(start: Date = new Date()): Clock {
  let current = new Date(start.getTime())
  return {
    now: () => new Date(current.getTime()),
    set(at) {
      current = new Date(at.getTime())
    },
    advance(ms) {
      current = new Date(current.getTime() + ms)
    },
  }
}

export interface ReplicaServices {
  product: ProductService
  inventory: InventoryService
  order: OrderService
  cart: CartService
  checkout: CheckoutService
}

export interface Replica {
  dialect: Dialect
  target: string
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  eventBus: InProcessEventBus
  logger: ReturnType<typeof createLogger>
  services: ReplicaServices
  /** A cart abandonment sweeper on this replica's store, on the replica's clock; stopped by `close`. */
  startSweeper(opts: { inactivityMs: number; batchSize?: number }): SweeperHandle
  close(): Promise<void>
}

function storageFor(dialect: Dialect, target: string) {
  return dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }
}

/** Applies the migrations to `target` once, before any replica opens it. */
export async function migrateTarget(dialect: Dialect, target: string): Promise<void> {
  const store = createCommandStore(kernelConfig(dialect), storageFor(dialect, target))
  try {
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await store.close()
  }
}

export async function openReplica(
  dialect: Dialect,
  target: string,
  opts: { clock: Clock; ttlSeconds?: number },
): Promise<Replica> {
  const config = kernelConfig(dialect)
  const store = createCommandStore(config, storageFor(dialect, target))
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const { publisher } = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus, logger },
  )
  const now = () => opts.clock.now()
  const currency = config.store.currency

  const product = createProductService({ store, repos, publisher, logger })
  const inventory = createInventoryService({ store, repos, publisher, logger })
  const order = createOrderService({
    store,
    repos,
    publisher,
    logger,
    orderNumberPrefix: 'P104',
    orderNumberStart: 1,
  })
  const cart = createCartService({
    store,
    carts: repos.cart,
    publisher,
    logger,
    currency,
    ...(opts.ttlSeconds !== undefined && { ttlSeconds: opts.ttlSeconds }),
    now,
  })
  const checkout = createCheckoutService({
    store,
    repos,
    publisher,
    logger,
    cart,
    orders: order,
    inventory,
    payments: createNativeStubPaymentsAdapter({ logger }),
    currency,
  })

  const sweepers: SweeperHandle[] = []
  return {
    dialect,
    target,
    store,
    repos,
    publisher,
    eventBus,
    logger,
    services: { product, inventory, order, cart, checkout },
    startSweeper(sweeperOpts) {
      const handle = startCartAbandonmentSweeper({
        store,
        carts: repos.cart,
        publisher,
        logger,
        intervalMs: 3_600_000,
        inactivityMs: sweeperOpts.inactivityMs,
        ...(sweeperOpts.batchSize !== undefined && { batchSize: sweeperOpts.batchSize }),
        now,
      })
      sweepers.push(handle)
      return handle
    },
    async close() {
      for (const s of sweepers) s.stop()
      await store.close()
    },
  }
}

/** The line `addItem` takes for a seeded variant. */
export function lineFor(
  seeded: { variantId: string; productId: string; priceMinor: number },
  qty: number,
) {
  return {
    variantId: seeded.variantId,
    productId: seeded.productId,
    productName: 'Transactional Widget',
    variantName: 'Default',
    priceMinor: seeded.priceMinor,
    imageUrl: '',
    qty,
  }
}
