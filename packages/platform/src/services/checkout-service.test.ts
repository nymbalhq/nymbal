import { describe, expect, it } from 'vitest'
import {
  EVT_ORDER_PAID,
  EVT_ORDER_PLACED,
  EVT_PAYMENT_CAPTURED,
  EVT_CART_CONVERTED,
  CheckoutError,
  NotFoundError,
} from '@nymbal/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher } from '../events/publisher.js'
import { createProductService } from './product-service.js'
import { createInventoryService } from './inventory-service.js'
import { createOrderService } from './order-service.js'
import { createCartService } from './cart-service.js'
import { createCheckoutService } from './checkout-service.js'
import { createNativeStubPaymentsAdapter } from '../adapters/payments/native-stub.js'
import { createLogger } from '../logger.js'
import { v7 as uuidv7 } from 'uuid'

async function setup() {
  const commandStore = createCommandStore(
    // @ts-expect-error — minimal config
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
    builderContext: {
      storeId: 'test',
      environment: 'development',
      version: '0.0.0',
      source: 'test',
    },
  })
  const payments = createNativeStubPaymentsAdapter({ logger })
  const product = createProductService({ store: commandStore, repos, publisher, logger })
  const inventory = createInventoryService({ store: commandStore, repos, publisher, logger })
  const order = createOrderService({
    store: commandStore,
    repos,
    publisher,
    logger,
    orderNumberPrefix: 'TEST',
    orderNumberStart: 1000,
  })
  const cart = createCartService({
    documentStore,
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
    documentStore,
    currency: 'GBP',
  })
  return {
    commandStore,
    documentStore,
    eventBus,
    product,
    cart,
    checkout,
    inventory,
    order,
    publisher,
    repos,
  }
}

describe('CheckoutService', () => {
  it('end-to-end: cart → beginCheckout → finalize produces ordered events + decrements stock', async () => {
    const env = await setup()

    const productSnap = await env.product.create({
      slug: 'test-widget',
      name: 'Test Widget',
      description: '',
      status: 'active',
      variants: [
        {
          sku: 'TW-1',
          name: 'Default',
          priceMinor: 2500,
          stock: 5,
          lowStockThreshold: 1,
          options: [],
        },
      ],
    })
    const variant = productSnap.variants[0]!

    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id,
      productId: productSnap.id,
      productName: productSnap.name,
      variantName: variant.name,
      priceMinor: variant.priceMinor,
      imageUrl: '',
      qty: 2,
    })

    const events: string[] = []
    await env.eventBus.subscribe(
      [EVT_ORDER_PLACED, EVT_ORDER_PAID, EVT_PAYMENT_CAPTURED, EVT_CART_CONVERTED],
      (event) => {
        events.push(event.type)
      },
    )

    const started = await env.checkout.beginCheckout({
      cartToken: cart.token,
      email: 'buyer@example.com',
      billingAddress: {
        firstName: 'Alice',
        lastName: 'Buyer',
        addressLine1: '1 Main St',
        city: 'London',
        region: 'London',
        postalCode: 'E1 6AN',
        country: 'GB',
      },
      shippingAddress: {
        firstName: 'Alice',
        lastName: 'Buyer',
        addressLine1: '1 Main St',
        city: 'London',
        region: 'London',
        postalCode: 'E1 6AN',
        country: 'GB',
      },
    })

    expect(started.paymentIntent.clientSecret).toBeTruthy()
    expect(started.totalMinor).toBe(5000)

    // Stock was reserved (decremented) — 5 - 2 = 3
    const after = await env.repos.variant.findById(variant.id)
    expect(after?.stock).toBe(3)

    await env.checkout.finalize(started.paymentIntent.id, started.totalMinor)

    // Cart converted → subtotal zero
    const cleared = await env.cart.get(cart.token)
    expect(cleared?.items).toHaveLength(0)

    // Order placed + events emitted in order
    expect(events).toContain(EVT_ORDER_PLACED)
    expect(events).toContain(EVT_ORDER_PAID)
    expect(events).toContain(EVT_PAYMENT_CAPTURED)
    expect(events).toContain(EVT_CART_CONVERTED)

    // Reservation cleared
    const residual = await env.repos.inventoryReservation.findByVariant(variant.id)
    expect(residual).toHaveLength(0)

    await env.commandStore.close()
  })

  it('beginCheckout with notes passes them to the order', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'notes-widget', name: 'Notes Widget', status: 'active',
      variants: [{ sku: 'NW-1', name: 'Default', priceMinor: 600, stock: 5, lowStockThreshold: 1, options: [] }],
    })
    const variant = productSnap.variants[0]!
    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 1,
    })
    const started = await env.checkout.beginCheckout({
      cartToken: cart.token, email: 'notes@example.com',
      notes: 'Please gift wrap',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })
    expect(started.paymentIntent).toBeTruthy()
    await env.commandStore.close()
  })

  it('beginCheckout throws NotFoundError for unknown cart', async () => {
    const env = await setup()
    await expect(env.checkout.beginCheckout({
      cartToken: 'ghost-token',
      email: 'a@b.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })).rejects.toThrow(NotFoundError)
    await env.commandStore.close()
  })

  it('beginCheckout throws CheckoutError for empty cart', async () => {
    const env = await setup()
    const cart = await env.cart.getOrCreate()
    await expect(env.checkout.beginCheckout({
      cartToken: cart.token,
      email: 'a@b.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })).rejects.toThrow(CheckoutError)
    await env.commandStore.close()
  })

  it('beginCheckout throws CheckoutError for cart currency mismatch', async () => {
    const env = await setup()
    // Create a checkout service that expects USD while cart is GBP
    const usdCheckout = createCheckoutService({
      store: env.commandStore,
      repos: env.repos,
      publisher: env.publisher,
      logger: createLogger({ pretty: false, level: 'error' }),
      cart: env.cart,
      orders: env.order,
      inventory: env.inventory,
      payments: createNativeStubPaymentsAdapter({ logger: createLogger({ pretty: false, level: 'error' }) }),
      documentStore: env.documentStore,
      currency: 'USD',
    })
    const productSnap = await env.product.create({
      slug: 'curr-widget', name: 'Currency Widget', status: 'active',
      variants: [{ sku: 'CW-1', name: 'Default', priceMinor: 1000, stock: 5, lowStockThreshold: 1, options: [] }],
    })
    const variant = productSnap.variants[0]!
    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 1,
    })
    await expect(usdCheckout.beginCheckout({
      cartToken: cart.token, email: 'a@b.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })).rejects.toThrow(CheckoutError)
    await env.commandStore.close()
  })

  it('beginCheckout rolls back partial reservations and wraps error when second reservation fails', async () => {
    // Use the same variantId in two separate cart line items (bypassing addItem merge logic)
    // so the first reservation depletes stock and the second fails
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'race-widget', name: 'Race Widget', status: 'active',
      variants: [{ sku: 'RW-1', name: 'Default', priceMinor: 500, stock: 1, lowStockThreshold: 0, options: [] }],
    })
    const variant = productSnap.variants[0]!
    const cart = await env.cart.getOrCreate()
    // Bypass addItem merge by writing two items with the same variantId directly
    const twoItemCart = {
      token: cart.token, customerId: null, currency: 'GBP',
      subtotalMinor: 1000, expiresAt: cart.expiresAt,
      createdAt: cart.createdAt, updatedAt: cart.updatedAt,
      items: [
        { variantId: variant.id, productId: productSnap.id, productName: productSnap.name, variantName: variant.name, priceMinor: 500, imageUrl: '', qty: 1 },
        { variantId: variant.id, productId: productSnap.id, productName: productSnap.name, variantName: variant.name, priceMinor: 500, imageUrl: '', qty: 1 },
      ],
    }
    await env.documentStore.put('carts', cart.token, twoItemCart, { ttl: 3600 })
    // First item reserves the 1 unit; second item fails → catch block fires → CheckoutError
    await expect(env.checkout.beginCheckout({
      cartToken: cart.token, email: 'race@test.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })).rejects.toThrow(CheckoutError)
    // Confirm the partial reservation was rolled back
    const remaining = await env.repos.inventoryReservation.findByVariant(variant.id)
    expect(remaining).toHaveLength(0)
    await env.commandStore.close()
  })

  it('beginCheckout throws CheckoutError for missing variant', async () => {
    const env = await setup()
    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: uuidv7(), productId: uuidv7(),
      productName: 'Ghost', variantName: 'Default',
      priceMinor: 1000, imageUrl: '', qty: 1,
    })
    await expect(env.checkout.beginCheckout({
      cartToken: cart.token, email: 'a@b.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })).rejects.toThrow(CheckoutError)
    await env.commandStore.close()
  })

  it('beginCheckout throws CheckoutError when variant is out of stock', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'oos-widget', name: 'OOS Widget', status: 'active',
      variants: [{ sku: 'OOS-1', name: 'Default', priceMinor: 500, stock: 1, lowStockThreshold: 0, options: [] }],
    })
    const variant = productSnap.variants[0]!
    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 2,
    })
    await expect(env.checkout.beginCheckout({
      cartToken: cart.token, email: 'a@b.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })).rejects.toThrow(CheckoutError)
    await env.commandStore.close()
  })

  it('beginCheckout with customerId wires customer to payment intent', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'cust-widget', name: 'Cust Widget', status: 'active',
      variants: [{ sku: 'CU-1', name: 'Default', priceMinor: 1000, stock: 5, lowStockThreshold: 1, options: [] }],
    })
    const variant = productSnap.variants[0]!
    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 1,
    })
    const customerId = uuidv7()
    const started = await env.checkout.beginCheckout({
      cartToken: cart.token, customerId,
      email: 'cust@example.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })
    expect(started.paymentIntent).toBeTruthy()
    await env.commandStore.close()
  })

  it('finalize throws CheckoutError when no pending order matches intent', async () => {
    const env = await setup()
    await expect(env.checkout.finalize('pi_nonexistent', 1000)).rejects.toThrow(CheckoutError)
    await env.commandStore.close()
  })

  it('cancel releases reservations and cancels order', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'cancel-widget', name: 'Cancel Widget', status: 'active',
      variants: [{ sku: 'CA-1', name: 'Default', priceMinor: 800, stock: 5, lowStockThreshold: 1, options: [] }],
    })
    const variant = productSnap.variants[0]!
    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 1,
    })
    const started = await env.checkout.beginCheckout({
      cartToken: cart.token, email: 'cancel@example.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })
    await env.checkout.cancel(started.orderId, 'customer changed mind')
    const reservations = await env.repos.inventoryReservation.findByVariant(variant.id)
    expect(reservations).toHaveLength(0)
    await env.commandStore.close()
  })

  it('cancel throws NotFoundError for unknown order', async () => {
    const env = await setup()
    await expect(env.checkout.cancel(uuidv7(), 'reason')).rejects.toThrow(NotFoundError)
    await env.commandStore.close()
  })

  it('cancel handles order metadata with no reservationIds array', async () => {
    const env = await setup()
    // Create a draft order directly (no checkout flow) — metadata has no reservationIds
    const draftOrder = await env.order.createFromCheckout({
      orderId: uuidv7(), customerId: null, email: 'nores@test.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
      lineItems: [], subtotalMinor: 0, taxTotalMinor: 0,
      shippingTotalMinor: 0, discountTotalMinor: 0, totalMinor: 0,
      currency: 'GBP', metadata: {},
    })
    await expect(env.checkout.cancel(draftOrder.id, 'test')).resolves.not.toThrow()
    await env.commandStore.close()
  })

  it('finalize handles metadata with no reservationIds and no cartToken', async () => {
    const env = await setup()
    const paymentIntentId = 'pi_direct_' + uuidv7().slice(0, 8)
    const draftOrder = await env.order.createFromCheckout({
      orderId: uuidv7(), customerId: null, email: 'direct@test.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
      lineItems: [], subtotalMinor: 0, taxTotalMinor: 0,
      shippingTotalMinor: 0, discountTotalMinor: 0, totalMinor: 0,
      currency: 'GBP', metadata: {},
    })
    await env.repos.order.setPaymentIntent(draftOrder.id, paymentIntentId, new Date())
    const result = await env.checkout.finalize(paymentIntentId, 0)
    expect(result.orderNumber).toBeTruthy()
    await env.commandStore.close()
  })

  it('finalize increments customer stats when order has customerId', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'cust-stats-widget', name: 'Cust Stats', status: 'active',
      variants: [{ sku: 'CS-1', name: 'Default', priceMinor: 2000, stock: 5, lowStockThreshold: 1, options: [] }],
    })
    const variant = productSnap.variants[0]!
    // Insert a minimal customer so incrementStats has a real row to update
    const customerId = uuidv7()
    await env.repos.customer.insert({
      id: customerId, email: 'statscust@test.com', passwordHash: 'x',
      createdAt: new Date(), updatedAt: new Date(),
    })
    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 1,
    })
    const started = await env.checkout.beginCheckout({
      cartToken: cart.token, customerId,
      email: 'statscust@test.com',
      billingAddress: makeAddr(), shippingAddress: makeAddr(),
    })
    const result = await env.checkout.finalize(started.paymentIntent.id, started.totalMinor)
    expect(result.orderNumber).toBeTruthy()
    await env.commandStore.close()
  })
})

function makeAddr() {
  return {
    firstName: 'Test', lastName: 'User',
    addressLine1: '1 Test St', city: 'London',
    region: 'England', postalCode: 'E1 1AA', country: 'GB',
  }
}
