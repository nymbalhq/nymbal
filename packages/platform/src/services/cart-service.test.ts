import { describe, expect, it } from 'vitest'
import { EVT_CART_CREATED, EVT_CART_ITEM_ADDED, EVT_CART_ITEM_REMOVED, EVT_CART_UPDATED, NotFoundError, ValidationError } from '@nymbal/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher } from '../events/publisher.js'
import { createCartService } from './cart-service.js'
import { createLogger } from '../logger.js'

function makeDeps() {
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const publisher = createEventPublisher({
    eventBus,
    builderContext: { storeId: 'test', environment: 'development', version: '0.0.0', source: 'test' },
  })
  const service = createCartService({ documentStore, publisher, logger, currency: 'GBP' })
  return { service, eventBus, documentStore }
}

const testItem = {
  variantId: 'var-1', productId: 'prod-1',
  productName: 'Test', variantName: 'Default',
  priceMinor: 1000, imageUrl: '',
}

describe('CartService', () => {
  it('getOrCreate creates a new cart and emits cart.created', async () => {
    const { service, eventBus } = makeDeps()
    const received: unknown[] = []
    await eventBus.subscribe(EVT_CART_CREATED, (e) => { received.push(e.payload) })
    const cart = await service.getOrCreate()
    expect(cart.token).toBeTruthy()
    expect(cart.items).toHaveLength(0)
    expect(received).toHaveLength(1)
  })

  it('getOrCreate returns existing cart on second call', async () => {
    const { service } = makeDeps()
    const a = await service.getOrCreate()
    const b = await service.getOrCreate(a.token)
    expect(b.token).toBe(a.token)
  })

  it('get returns null for unknown token', async () => {
    const { service } = makeDeps()
    expect(await service.get('nope')).toBeNull()
  })

  it('addItem adds item to cart and emits item.added + updated', async () => {
    const { service, eventBus } = makeDeps()
    const added: unknown[] = []
    const updated: unknown[] = []
    await eventBus.subscribe(EVT_CART_ITEM_ADDED, (e) => { added.push(e.payload) })
    await eventBus.subscribe(EVT_CART_UPDATED, (e) => { updated.push(e.payload) })
    const cart = await service.getOrCreate()
    const updated_cart = await service.addItem(cart.token, testItem)
    expect(updated_cart.items).toHaveLength(1)
    expect(updated_cart.subtotalMinor).toBe(1000)
    expect(added).toHaveLength(1)
    expect(updated.length).toBeGreaterThanOrEqual(1)
  })

  it('addItem accumulates qty for same variant', async () => {
    const { service } = makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, { ...testItem, qty: 2 })
    const final = await service.addItem(cart.token, { ...testItem, qty: 3 })
    expect(final.items[0]!.qty).toBe(5)
    expect(final.subtotalMinor).toBe(5000)
  })

  it('addItem rejects qty <= 0', async () => {
    const { service } = makeDeps()
    const cart = await service.getOrCreate()
    await expect(service.addItem(cart.token, { ...testItem, qty: 0 })).rejects.toThrow(ValidationError)
  })

  it('addItem throws for unknown cart token', async () => {
    const { service } = makeDeps()
    await expect(service.addItem('unknown', testItem)).rejects.toThrow(NotFoundError)
  })

  it('updateItemQuantity changes qty', async () => {
    const { service } = makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    const updated = await service.updateItemQuantity(cart.token, testItem.variantId, 5)
    expect(updated.items[0]!.qty).toBe(5)
    expect(updated.subtotalMinor).toBe(5000)
  })

  it('updateItemQuantity with qty=0 removes item and emits removed', async () => {
    const { service, eventBus } = makeDeps()
    const removed: unknown[] = []
    await eventBus.subscribe(EVT_CART_ITEM_REMOVED, (e) => { removed.push(e.payload) })
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    const updated = await service.updateItemQuantity(cart.token, testItem.variantId, 0)
    expect(updated.items).toHaveLength(0)
    expect(removed).toHaveLength(1)
  })

  it('updateItemQuantity rejects negative qty', async () => {
    const { service } = makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    await expect(service.updateItemQuantity(cart.token, testItem.variantId, -1)).rejects.toThrow(ValidationError)
  })

  it('updateItemQuantity throws for missing variant', async () => {
    const { service } = makeDeps()
    const cart = await service.getOrCreate()
    await expect(service.updateItemQuantity(cart.token, 'var-none', 2)).rejects.toThrow(NotFoundError)
  })

  it('removeItem removes item and emits removed', async () => {
    const { service, eventBus } = makeDeps()
    const removed: unknown[] = []
    await eventBus.subscribe(EVT_CART_ITEM_REMOVED, (e) => { removed.push(e.payload) })
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    const updated = await service.removeItem(cart.token, testItem.variantId)
    expect(updated.items).toHaveLength(0)
    expect(removed).toHaveLength(1)
  })

  it('removeItem on non-existent variant still resolves (no event)', async () => {
    const { service, eventBus } = makeDeps()
    const removed: unknown[] = []
    await eventBus.subscribe(EVT_CART_ITEM_REMOVED, (e) => { removed.push(e.payload) })
    const cart = await service.getOrCreate()
    const updated = await service.removeItem(cart.token, 'var-ghost')
    expect(updated.items).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 10))
    expect(removed).toHaveLength(0)
  })

  it('clear empties cart', async () => {
    const { service } = makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    const cleared = await service.clear(cart.token)
    expect(cleared.items).toHaveLength(0)
    expect(cleared.subtotalMinor).toBe(0)
  })

  it('attachCustomer sets customerId', async () => {
    const { service } = makeDeps()
    const cart = await service.getOrCreate()
    const updated = await service.attachCustomer(cart.token, 'cust-1')
    expect(updated.customerId).toBe('cust-1')
  })

  it('merge: if guest missing, returns customer cart', async () => {
    const { service } = makeDeps()
    const customerCart = await service.getOrCreate()
    const merged = await service.merge('ghost-token', customerCart.token)
    expect(merged.token).toBe(customerCart.token)
  })

  it('merge: if customer cart missing, renames guest cart to customerToken', async () => {
    const { service } = makeDeps()
    const guest = await service.getOrCreate()
    await service.addItem(guest.token, { ...testItem, variantId: 'g-var' })
    const merged = await service.merge(guest.token, 'new-cust-token')
    expect(merged.token).toBe('new-cust-token')
    expect(merged.items).toHaveLength(1)
  })

  it('merge: combines guest items into customer cart', async () => {
    const { service } = makeDeps()
    const guestItem = { variantId: 'g-var', productId: 'p2', productName: 'G', variantName: 'D', priceMinor: 500, imageUrl: '' }
    const guest = await service.getOrCreate()
    await service.addItem(guest.token, guestItem)
    const customerCart = await service.getOrCreate()
    await service.addItem(customerCart.token, testItem)
    const merged = await service.merge(guest.token, customerCart.token)
    expect(merged.items).toHaveLength(2)
  })

  it('merge: duplicate variant takes max qty', async () => {
    const { service } = makeDeps()
    const guest = await service.getOrCreate()
    await service.addItem(guest.token, { ...testItem, qty: 5 })
    const customerCart = await service.getOrCreate()
    await service.addItem(customerCart.token, { ...testItem, qty: 3 })
    const merged = await service.merge(guest.token, customerCart.token)
    expect(merged.items[0]!.qty).toBe(5)
  })
})
