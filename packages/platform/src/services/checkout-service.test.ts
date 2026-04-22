import { describe, expect, it } from 'vitest'
import {
  EVT_ORDER_PAID,
  EVT_ORDER_PLACED,
  EVT_PAYMENT_CAPTURED,
  EVT_CART_CONVERTED,
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
})
