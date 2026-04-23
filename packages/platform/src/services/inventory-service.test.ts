import { describe, expect, it } from 'vitest'
import { AdapterError, EVT_INVENTORY_CHANGED, EVT_INVENTORY_RESERVED, EVT_INVENTORY_RELEASED, EVT_INVENTORY_LOW_STOCK, EVT_INVENTORY_OUT_OF_STOCK, NotFoundError, ValidationError } from '@nymbal/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher } from '../events/publisher.js'
import { createProductService } from './product-service.js'
import { createInventoryService } from './inventory-service.js'
import { createLogger } from '../logger.js'

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
  const inventory = createInventoryService({ store: commandStore, repos, publisher, logger })
  return { commandStore, eventBus, product, inventory, repos }
}

async function createTestVariant(product: ReturnType<typeof import('./product-service.js').createProductService>, stock = 20) {
  const snap = await product.create({
    slug: `inv-test-${Math.random().toString(36).slice(2)}`,
    name: 'Inventory Test',
    description: '',
    status: 'active',
    variants: [{ sku: 'INV-1', name: 'Default', priceMinor: 1000, stock, lowStockThreshold: 3, options: [] }],
  })
  return snap.variants[0]!
}

describe('InventoryService', () => {
  it('adjustStock increases stock and emits inventory.changed', async () => {
    const { commandStore, eventBus, product, inventory, repos } = await setup()
    const variant = await createTestVariant(product, 10)
    const changed: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_CHANGED, (e) => { changed.push(e.payload) })
    const result = await inventory.adjustStock(variant.id, 5, 'manual', 'admin')
    expect(result.newQty).toBe(15)
    const fresh = await repos.variant.findById(variant.id)
    expect(fresh?.stock).toBe(15)
    expect(changed.length).toBeGreaterThanOrEqual(1)
    await commandStore.close()
  })

  it('adjustStock decreases stock', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 10)
    const result = await inventory.adjustStock(variant.id, -4, 'manual', 'admin')
    expect(result.newQty).toBe(6)
    await commandStore.close()
  })

  it('adjustStock throws ValidationError when going below zero', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 5)
    await expect(inventory.adjustStock(variant.id, -10, 'manual', 'admin')).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('adjustStock throws NotFoundError for unknown variant', async () => {
    const { commandStore, inventory } = await setup()
    await expect(inventory.adjustStock('nope', 1, 'manual', 'admin')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('adjustStock emits low_stock when threshold crossed', async () => {
    const { commandStore, eventBus, product, inventory } = await setup()
    const variant = await createTestVariant(product, 5)
    const lowStock: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_LOW_STOCK, (e) => { lowStock.push(e.payload) })
    await inventory.adjustStock(variant.id, -3, 'manual', 'admin')
    await new Promise((r) => setTimeout(r, 10))
    expect(lowStock).toHaveLength(1)
    await commandStore.close()
  })

  it('adjustStock emits out_of_stock when stock reaches zero', async () => {
    const { commandStore, eventBus, product, inventory } = await setup()
    const variant = await createTestVariant(product, 3)
    const oos: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_OUT_OF_STOCK, (e) => { oos.push(e.payload) })
    await inventory.adjustStock(variant.id, -3, 'manual', 'admin')
    await new Promise((r) => setTimeout(r, 10))
    expect(oos).toHaveLength(1)
    await commandStore.close()
  })

  it('reserveStock deducts from available stock and emits reserved', async () => {
    const { commandStore, eventBus, product, inventory, repos } = await setup()
    const variant = await createTestVariant(product, 20)
    const reserved: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_RESERVED, (e) => { reserved.push(e.payload) })
    const result = await inventory.reserveStock(variant.id, 5)
    expect(result.reservationId).toBeTruthy()
    expect(result.expiresAt).toBeTruthy()
    const fresh = await repos.variant.findById(variant.id)
    expect(fresh?.stock).toBe(15)
    await new Promise((r) => setTimeout(r, 10))
    expect(reserved).toHaveLength(1)
    await commandStore.close()
  })

  it('reserveStock throws when insufficient stock', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 5)
    await expect(inventory.reserveStock(variant.id, 10)).rejects.toThrow(AdapterError)
    await commandStore.close()
  })

  it('reserveStock rejects qty <= 0', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 10)
    await expect(inventory.reserveStock(variant.id, 0)).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('releaseReservation restores stock and emits released', async () => {
    const { commandStore, eventBus, product, inventory, repos } = await setup()
    const variant = await createTestVariant(product, 10)
    const { reservationId } = await inventory.reserveStock(variant.id, 4)
    const released: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_RELEASED, (e) => { released.push(e.payload) })
    await inventory.releaseReservation(reservationId, 'cancelled')
    const fresh = await repos.variant.findById(variant.id)
    expect(fresh?.stock).toBe(10)
    await new Promise((r) => setTimeout(r, 10))
    expect(released).toHaveLength(1)
    await commandStore.close()
  })

  it('releaseReservation is idempotent (missing reservation is silently ignored)', async () => {
    const { commandStore, inventory } = await setup()
    await expect(inventory.releaseReservation('ghost-id', 'abandoned')).resolves.not.toThrow()
    await commandStore.close()
  })

  it('commitReservation removes reservation without restoring stock', async () => {
    const { commandStore, product, inventory, repos } = await setup()
    const variant = await createTestVariant(product, 10)
    const { reservationId } = await inventory.reserveStock(variant.id, 4)
    await inventory.commitReservation(reservationId, 'fulfillment')
    const resAfter = await repos.inventoryReservation.findById(reservationId)
    expect(resAfter).toBeNull()
    const fresh = await repos.variant.findById(variant.id)
    expect(fresh?.stock).toBe(6)
    await commandStore.close()
  })

  it('commitReservation throws for unknown reservation', async () => {
    const { commandStore, inventory } = await setup()
    await expect(inventory.commitReservation('nope', 'fulfillment')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('getStockStatus returns correct status for in_stock', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 20)
    const status = await inventory.getStockStatus(variant.id)
    expect(status.status).toBe('in_stock')
    expect(status.stock).toBe(20)
    await commandStore.close()
  })

  it('getStockStatus returns low_stock when at threshold', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 3)
    const status = await inventory.getStockStatus(variant.id)
    expect(status.status).toBe('low_stock')
    await commandStore.close()
  })

  it('getStockStatus returns out_of_stock when zero', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 0)
    const status = await inventory.getStockStatus(variant.id)
    expect(status.status).toBe('out_of_stock')
    await commandStore.close()
  })

  it('getStockStatus throws NotFoundError for unknown variant', async () => {
    const { commandStore, inventory } = await setup()
    await expect(inventory.getStockStatus('nope')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })
})
