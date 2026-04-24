import { describe, expect, it } from 'vitest'
import { EVT_ORDER_PLACED, EVT_ORDER_SHIPPED, EVT_ORDER_DELIVERED, EVT_ORDER_CANCELLED, EVT_ORDER_REFUNDED, EVT_ORDER_PARTIALLY_REFUNDED, EVT_ORDER_PAID, NotFoundError } from '@nymbal/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher } from '../events/publisher.js'
import { createOrderService } from './order-service.js'
import { createProductService } from './product-service.js'
import { createLogger } from '../logger.js'
import { v7 as uuidv7 } from 'uuid'
import type { Address, OrderLineItem } from '@nymbal/types'

const addr: Address = {
  firstName: 'Jane', lastName: 'Doe',
  addressLine1: '1 Test St', city: 'London',
  region: 'England', postalCode: 'SW1A 1AA', country: 'GB',
}

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
  const orderService = createOrderService({
    store: commandStore, repos, publisher, logger,
    orderNumberPrefix: 'TEST', orderNumberStart: 1000,
  })
  return { commandStore, eventBus, orderService, product, repos }
}

async function createLine(price = 2500, qty = 1): Promise<OrderLineItem> {
  return {
    variantId: uuidv7(), productId: uuidv7(),
    productName: 'Test', variantName: 'Default',
    sku: 'SKU-1', qty,
    unitPriceMinor: price, lineSubtotalMinor: price * qty,
    lineTaxMinor: 0, lineTotalMinor: price * qty, imageUrl: '',
  }
}

describe('OrderService', () => {
  it('createFromCheckout emits order.placed + returns order with orderNumber', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_PLACED, (e) => { received.push(e.payload) })
    const line = await createLine()
    const order = await orderService.createFromCheckout({
      orderId: uuidv7(), customerId: null,
      email: 'test@example.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor, taxTotalMinor: 0,
      shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    expect(order.orderNumber).toMatch(/^TEST-/)
    expect(order.status).toBe('pending')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('getById returns created order', async () => {
    const { commandStore, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'a@b.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    const fetched = await orderService.getById(id)
    expect(fetched.id).toBe(id)
    await commandStore.close()
  })

  it('getById throws NotFoundError for unknown id', async () => {
    const { commandStore, orderService } = await setup()
    await expect(orderService.getById('nope')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('getByOrderNumber returns order', async () => {
    const { commandStore, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    const created = await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'b@c.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    const found = await orderService.getByOrderNumber(created.orderNumber)
    expect(found.id).toBe(id)
    await commandStore.close()
  })

  it('getByOrderNumber throws for unknown order number', async () => {
    const { commandStore, orderService } = await setup()
    await expect(orderService.getByOrderNumber('NOPE-999')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('listByCustomer returns orders for that customer', async () => {
    const { commandStore, orderService } = await setup()
    const customerId = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: uuidv7(), customerId, email: 'c@d.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    const list = await orderService.listByCustomer(customerId)
    expect(list.length).toBe(1)
    expect(list[0]!.customerId).toBe(customerId)
    await commandStore.close()
  })

  it('updateStatus transitions pending → confirmed', async () => {
    const { commandStore, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'd@e.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    const updated = await orderService.updateStatus(id, 'confirmed', 'admin')
    expect(updated.status).toBe('confirmed')
    await commandStore.close()
  })

  it('updateStatus throws on invalid transition', async () => {
    const { commandStore, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'e@f.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    await expect(orderService.updateStatus(id, 'delivered', 'admin')).rejects.toThrow()
    await commandStore.close()
  })

  it('markShipped emits shipped event', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'f@g.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    await orderService.updateStatus(id, 'confirmed', 'admin')
    await orderService.updateStatus(id, 'processing', 'admin')
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_SHIPPED, (e) => { received.push(e.payload) })
    const shipped = await orderService.markShipped(id, 'TRK123', 'Royal Mail', 'admin')
    expect(shipped.status).toBe('shipped')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('markDelivered transitions shipped → delivered', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'g@h.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    await orderService.updateStatus(id, 'confirmed', 'admin')
    await orderService.updateStatus(id, 'processing', 'admin')
    await orderService.markShipped(id, 'TRK999', 'DHL', 'admin')
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_DELIVERED, (e) => { received.push(e.payload) })
    const delivered = await orderService.markDelivered(id, 'admin')
    expect(delivered.status).toBe('delivered')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('cancel emits order.cancelled', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'h@i.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_CANCELLED, (e) => { received.push(e.payload) })
    const cancelled = await orderService.cancel(id, 'test reason', 'admin')
    expect(cancelled.status).toBe('cancelled')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('refund emits order.refunded from delivered state', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'i@j.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    await orderService.updateStatus(id, 'confirmed', 'admin')
    await orderService.updateStatus(id, 'processing', 'admin')
    await orderService.markShipped(id, 'TRK1', 'DPD', 'admin')
    await orderService.markDelivered(id, 'admin')
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_REFUNDED, (e) => { received.push(e.payload) })
    const refunded = await orderService.refund(id, line.lineTotalMinor, 'damaged', 'admin')
    expect(refunded.status).toBe('refunded')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('partialRefund transitions delivered → partially_refunded', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'j@k.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    await orderService.updateStatus(id, 'confirmed', 'admin')
    await orderService.updateStatus(id, 'processing', 'admin')
    await orderService.markShipped(id, 'TRK2', 'DPD', 'admin')
    await orderService.markDelivered(id, 'admin')
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_PARTIALLY_REFUNDED, (e) => { received.push(e.payload) })
    const partial = await orderService.partialRefund(id, 500, [], 'one item damaged', 'admin')
    expect(partial.status).toBe('partially_refunded')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('markPaid emits order.paid event', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id, customerId: null, email: 'k@l.com',
      billingAddress: addr, shippingAddress: addr,
      lineItems: [line], subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0, shippingTotalMinor: 0, discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor, currency: 'GBP',
    })
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_PAID, (e) => { received.push(e.payload) })
    await orderService.markPaid(id, 'pi_test_123', line.lineTotalMinor, 'GBP')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })
})
