import { describe, it, expect } from 'vitest'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../src/event-bus/in-process.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { buildRepositories } from '../../src/repositories/index.js'
import { createEventPublisher } from '../../src/events/publisher.js'
import { createProductService } from '../../src/services/product-service.js'
import { createInventoryService } from '../../src/services/inventory-service.js'
import { EVT_INVENTORY_RELEASED } from '@nymbal/types'
import { createLogger } from '../../src/logger.js'

async function setup() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config
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
  const publisher = createEventPublisher({
    eventBus,
    builderContext: { storeId: 'test', environment: 'development', version: '0.0.0', source: 'test' },
  })
  const product = createProductService({ store: commandStore, repos, publisher, logger })
  const inventory = createInventoryService({
    store: commandStore, repos, publisher, logger,
    defaultReservationTtlSeconds: 1,
  })
  return { commandStore, eventBus, repos, product, inventory }
}

describe('Reservation timeout / release', () => {
  it('explicit release restores stock and emits inventory.released', async () => {
    const { commandStore, eventBus, product, inventory, repos } = await setup()

    const snap = await product.create({
      slug: 'timeout-widget',
      name: 'Timeout Widget',
      description: '',
      status: 'active',
      variants: [{ sku: 'TW-1', name: 'Default', priceMinor: 1000, stock: 10, options: [] }],
    })
    const variant = snap.variants[0]!

    const released: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_RELEASED, (e) => { released.push(e.payload) })

    const { reservationId } = await inventory.reserveStock(variant.id, 3)

    // Stock was decremented
    const during = await repos.variant.findById(variant.id)
    expect(during?.stock).toBe(7)

    // Explicit release (simulating timeout handler)
    await inventory.releaseReservation(reservationId, 'expired')

    const after = await repos.variant.findById(variant.id)
    expect(after?.stock).toBe(10)

    await new Promise((r) => setTimeout(r, 10))
    expect(released.length).toBeGreaterThanOrEqual(1)

    await commandStore.close()
  })

  it('releasing the same reservation twice is idempotent', async () => {
    const { commandStore, product, inventory } = await setup()

    const snap = await product.create({
      slug: 'idempotent-release',
      name: 'Idempotent Release',
      description: '',
      status: 'active',
      variants: [{ sku: 'IR-1', name: 'Default', priceMinor: 1000, stock: 5, options: [] }],
    })
    const variant = snap.variants[0]!

    const { reservationId } = await inventory.reserveStock(variant.id, 2)
    await inventory.releaseReservation(reservationId, 'cancelled')
    await expect(inventory.releaseReservation(reservationId, 'cancelled')).resolves.not.toThrow()

    await commandStore.close()
  })
})
