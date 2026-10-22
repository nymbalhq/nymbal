import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import {
  EVT_ORDER_PAID,
  EVT_ORDER_PLACED,
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_FAILED,
  EVT_CART_CONVERTED,
  EVT_CART_UPDATED,
  EVT_ORDER_CANCELLED,
  EVT_PAYMENT_REFUNDED,
  CheckoutError,
  NotFoundError,
  OrderConflictError,
  PaymentError,
  StatusTransitionError,
  type Refund,
  type RefundOptions,
  type PaymentIntentParams,
  type PaymentsAdapter,
  type PaymentStatus,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
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
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
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
  return {
    commandStore,
    eventBus,
    product,
    cart,
    checkout,
    inventory,
    order,
    payments,
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
    expect(started.totalMinor).toBe(variant.priceMinor * 2)

    // Stock was reserved (decremented) by the cart's qty
    const after = await env.commandStore.read((tx) => env.repos.variant.findById(tx, variant.id))
    expect(after?.stock).toBe(variant.stock - 2)

    await env.checkout.finalize(started.paymentIntent.id, {
      amountMinor: started.totalMinor,
      currency: started.currency,
    })

    // Cart converted → subtotal zero
    const cleared = await env.cart.get(cart.token)
    expect(cleared?.items).toHaveLength(0)

    // Order placed + events emitted in order
    expect(events).toContain(EVT_ORDER_PLACED)
    expect(events).toContain(EVT_ORDER_PAID)
    expect(events).toContain(EVT_PAYMENT_CAPTURED)
    expect(events).toContain(EVT_CART_CONVERTED)

    // Reservation cleared
    const residual = await env.commandStore.read((tx) =>
      env.repos.inventoryReservation.findByVariant(tx, variant.id),
    )
    expect(residual).toHaveLength(0)

    await env.commandStore.close()
  })

  it('beginCheckout with notes passes them to the order', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'notes-widget',
      name: 'Notes Widget',
      status: 'active',
      variants: [
        {
          sku: 'NW-1',
          name: 'Default',
          priceMinor: 600,
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
      qty: 1,
    })
    const started = await env.checkout.beginCheckout({
      cartToken: cart.token,
      email: 'notes@example.com',
      notes: 'Please gift wrap',
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
    })
    expect(started.paymentIntent).toBeTruthy()
    await env.commandStore.close()
  })

  it('beginCheckout throws NotFoundError for unknown cart', async () => {
    const env = await setup()
    await expect(
      env.checkout.beginCheckout({
        cartToken: 'ghost-token',
        email: 'a@b.com',
        billingAddress: makeAddr(),
        shippingAddress: makeAddr(),
      }),
    ).rejects.toThrow(NotFoundError)
    await env.commandStore.close()
  })

  it('beginCheckout throws CheckoutError for empty cart', async () => {
    const env = await setup()
    const cart = await env.cart.getOrCreate()
    await expect(
      env.checkout.beginCheckout({
        cartToken: cart.token,
        email: 'a@b.com',
        billingAddress: makeAddr(),
        shippingAddress: makeAddr(),
      }),
    ).rejects.toThrow(CheckoutError)
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
      payments: createNativeStubPaymentsAdapter({
        logger: createLogger({ pretty: false, level: 'error' }),
      }),
      currency: 'USD',
    })
    const productSnap = await env.product.create({
      slug: 'curr-widget',
      name: 'Currency Widget',
      status: 'active',
      variants: [
        {
          sku: 'CW-1',
          name: 'Default',
          priceMinor: 1000,
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
      qty: 1,
    })
    await expect(
      usdCheckout.beginCheckout({
        cartToken: cart.token,
        email: 'a@b.com',
        billingAddress: makeAddr(),
        shippingAddress: makeAddr(),
      }),
    ).rejects.toThrow(CheckoutError)
    await env.commandStore.close()
  })

  it('beginCheckout rolls back the earlier reservation and wraps the error when a later reservation fails', async () => {
    // A cart of two distinct variants (one line per variant is a cart invariant) over an inventory whose second
    // reservation is refused: the first one's row and decrement must roll back with the failed transaction.
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'race-widget',
      name: 'Race Widget',
      status: 'active',
      variants: [
        { sku: 'RW-1', name: 'One', priceMinor: 500, stock: 3, lowStockThreshold: 0, options: [] },
        { sku: 'RW-2', name: 'Two', priceMinor: 700, stock: 3, lowStockThreshold: 0, options: [] },
      ],
    })
    const variants = productSnap.variants
    expect(variants).toHaveLength(2)
    let reservations = 0
    const inventory: typeof env.inventory = {
      ...env.inventory,
      async reserveStock(...args) {
        reservations += 1
        if (reservations === 2) throw new Error('second reservation refused')
        return env.inventory.reserveStock(...args)
      },
    }
    const logger = createLogger({ pretty: false, level: 'error' })
    const checkout = createCheckoutService({
      store: env.commandStore,
      repos: env.repos,
      publisher: env.publisher,
      logger,
      cart: env.cart,
      orders: env.order,
      inventory,
      payments: createNativeStubPaymentsAdapter({ logger }),
      currency: 'GBP',
    })
    const cart = await env.cart.getOrCreate()
    for (const variant of variants) {
      await env.cart.addItem(cart.token, {
        variantId: variant.id,
        productId: productSnap.id,
        productName: productSnap.name,
        variantName: variant.name,
        priceMinor: variant.priceMinor,
        imageUrl: '',
        qty: 1,
      })
    }
    await expect(
      checkout.beginCheckout({
        cartToken: cart.token,
        email: 'race@test.com',
        billingAddress: makeAddr(),
        shippingAddress: makeAddr(),
      }),
    ).rejects.toThrow(CheckoutError)
    expect(reservations).toBe(2)
    for (const variant of variants) {
      const remaining = await env.commandStore.read((tx) =>
        env.repos.inventoryReservation.findByVariant(tx, variant.id),
      )
      expect(remaining).toHaveLength(0)
      const after = await env.commandStore.read((tx) => env.repos.variant.findById(tx, variant.id))
      expect(after?.stock).toBe(variant.stock)
    }
    await env.commandStore.close()
  })

  it('beginCheckout throws CheckoutError for missing variant', async () => {
    const env = await setup()
    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: uuidv7(),
      productId: uuidv7(),
      productName: 'Ghost',
      variantName: 'Default',
      priceMinor: 1000,
      imageUrl: '',
      qty: 1,
    })
    await expect(
      env.checkout.beginCheckout({
        cartToken: cart.token,
        email: 'a@b.com',
        billingAddress: makeAddr(),
        shippingAddress: makeAddr(),
      }),
    ).rejects.toThrow(CheckoutError)
    await env.commandStore.close()
  })

  it('beginCheckout throws CheckoutError when variant is out of stock', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'oos-widget',
      name: 'OOS Widget',
      status: 'active',
      variants: [
        {
          sku: 'OOS-1',
          name: 'Default',
          priceMinor: 500,
          stock: 1,
          lowStockThreshold: 0,
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
    await expect(
      env.checkout.beginCheckout({
        cartToken: cart.token,
        email: 'a@b.com',
        billingAddress: makeAddr(),
        shippingAddress: makeAddr(),
      }),
    ).rejects.toThrow(CheckoutError)
    await env.commandStore.close()
  })

  it('beginCheckout with customerId wires customer to payment intent', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'cust-widget',
      name: 'Cust Widget',
      status: 'active',
      variants: [
        {
          sku: 'CU-1',
          name: 'Default',
          priceMinor: 1000,
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
      qty: 1,
    })
    const customerId = uuidv7()
    const started = await env.checkout.beginCheckout({
      cartToken: cart.token,
      customerId,
      email: 'cust@example.com',
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
    })
    expect(started.paymentIntent).toBeTruthy()
    await env.commandStore.close()
  })

  it('cancel releases reservations and cancels order', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'cancel-widget',
      name: 'Cancel Widget',
      status: 'active',
      variants: [
        {
          sku: 'CA-1',
          name: 'Default',
          priceMinor: 800,
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
      qty: 1,
    })
    const started = await env.checkout.beginCheckout({
      cartToken: cart.token,
      // Pending, so the order holds no capture and may be cancelled (P1-13 decision 4).
      email: 'cancel+stub-pending@example.com',
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
    })
    await env.checkout.cancel(started.orderId, 'customer changed mind')
    const reservations = await env.commandStore.read((tx) =>
      env.repos.inventoryReservation.findByVariant(tx, variant.id),
    )
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
      orderId: uuidv7(),
      customerId: null,
      email: 'nores@test.com',
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
      lineItems: [],
      subtotalMinor: 0,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 0,
      currency: 'GBP',
      metadata: {},
    })
    await expect(env.checkout.cancel(draftOrder.id, 'test')).resolves.not.toThrow()
    await env.commandStore.close()
  })

  it('finalize handles metadata with no reservationIds and no cartToken', async () => {
    const env = await setup()
    const paymentIntentId = 'pi_direct_' + uuidv7().slice(0, 8)
    const draftOrder = await env.order.createFromCheckout({
      orderId: uuidv7(),
      customerId: null,
      email: 'direct@test.com',
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
      lineItems: [],
      subtotalMinor: 0,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 0,
      currency: 'GBP',
      metadata: {},
    })
    await env.commandStore.transaction((tx) =>
      env.repos.order.setPaymentIntent(tx, draftOrder.id, paymentIntentId, new Date()),
    )
    const result = await env.checkout.finalize(paymentIntentId, { amountMinor: 0, currency: 'GBP' })
    expect(result).toEqual({ orderNumber: draftOrder.orderNumber, finalized: true })
    // Defect: an order with no cart still announces a conversion (of cart `undefined`).
    const logged = await env.commandStore.read((tx) => env.repos.eventLog.listAll(tx))
    const conversions = logged.filter((l) => l.event.type === EVT_CART_CONVERTED)
    const paidOrders = logged.filter((l) => l.event.type === EVT_ORDER_PAID)
    expect(paidOrders).toHaveLength(1)
    expect(conversions).toHaveLength(paidOrders.length - 1)
    await env.commandStore.close()
  })

  it('finalize increments customer stats when order has customerId', async () => {
    const env = await setup()
    const productSnap = await env.product.create({
      slug: 'cust-stats-widget',
      name: 'Cust Stats',
      status: 'active',
      variants: [
        {
          sku: 'CS-1',
          name: 'Default',
          priceMinor: 2000,
          stock: 5,
          lowStockThreshold: 1,
          options: [],
        },
      ],
    })
    const variant = productSnap.variants[0]!
    // Insert a minimal customer so incrementStats has a real row to update
    const customerId = uuidv7()
    await env.commandStore.transaction((tx) =>
      env.repos.customer.insert(tx, {
        id: customerId,
        email: 'statscust@test.com',
        passwordHash: 'x',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )
    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id,
      productId: productSnap.id,
      productName: productSnap.name,
      variantName: variant.name,
      priceMinor: variant.priceMinor,
      imageUrl: '',
      qty: 1,
    })
    const started = await env.checkout.beginCheckout({
      cartToken: cart.token,
      customerId,
      email: 'statscust@test.com',
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
    })
    const paid = { amountMinor: started.totalMinor, currency: started.currency }
    const result = await env.checkout.finalize(started.paymentIntent.id, paid)
    expect(result.orderNumber).toBe(started.orderNumber)
    // A second delivery for the confirmed order must not count the order or its spend again (AC-12).
    await env.checkout.finalize(started.paymentIntent.id, paid)
    const customer = await env.commandStore.read((tx) =>
      env.repos.customer.findById(tx, customerId),
    )
    expect(customer?.orderCount).toBe(1)
    expect(customer?.totalSpentMinor).toBe(started.totalMinor)
    await env.commandStore.close()
  })
})

// P1-05 decision 4: finalize's check order, one test per branch. Stryker runs only src tests, so these are what
// kill its mutants in finalize (the integration suites prove the same outcomes on both dialects).
describe('CheckoutService.finalize: decision 4 check order and recorded outcomes', () => {
  type Env = Awaited<ReturnType<typeof setup>>
  type Line = { priceMinor: number; stock: number; qty: number }

  async function placeOrder(env: Env, lines: Line[], customerId?: string) {
    const tag = uuidv7().slice(-8)
    const product = await env.product.create({
      slug: `finalize-${tag}`,
      name: `Finalize ${tag}`,
      status: 'active',
      variants: lines.map((l, i) => ({
        sku: `FIN-${tag}-${i}`,
        name: `V${i}`,
        priceMinor: l.priceMinor,
        stock: l.stock,
        lowStockThreshold: 0,
        options: [],
      })),
    })
    const cart = await env.cart.getOrCreate()
    for (const [i, variant] of product.variants.entries()) {
      await env.cart.addItem(cart.token, {
        variantId: variant.id,
        productId: product.id,
        productName: product.name,
        variantName: variant.name,
        priceMinor: variant.priceMinor,
        imageUrl: '',
        qty: lines[i]!.qty,
      })
    }
    const started = await env.checkout.beginCheckout({
      cartToken: cart.token,
      ...(customerId !== undefined && { customerId }),
      // `+stub-pending` (P1-12 decision 7): every finalize below meets a pending order, as a webhook would.
      email: `${tag}+stub-pending@example.com`,
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
    })
    const paid = { amountMinor: started.totalMinor, currency: started.currency }
    return { started, variants: product.variants, paid, cartToken: cart.token }
  }

  const read = <T>(
    env: Env,
    fn: (tx: Parameters<Parameters<Env['commandStore']['read']>[0]>[0]) => Promise<T>,
  ) => env.commandStore.read(fn)

  /** Payloads of `type` in the outbox, the durable record of what finalize published. */
  async function payloads(env: Env, type: string, where: (p: Record<string, unknown>) => boolean) {
    const all = await read(env, (tx) => env.repos.eventLog.listAll(tx))
    return all
      .map((l) => l.event)
      .filter((e) => e.type === type)
      .map((e) => e.payload as Record<string, unknown>)
      .filter(where)
  }
  const events = (env: Env, type: string, orderId: string) =>
    payloads(env, type, (p) => p.orderId === orderId)
  const stockOf = async (env: Env, variantId: string) =>
    (await read(env, (tx) => env.repos.variant.findById(tx, variantId)))!.stock
  const commitsOf = async (env: Env, variantId: string) =>
    (await read(env, (tx) => env.repos.stockAdjustment.listByVariant(tx, variantId))).filter(
      (a) => a.reason === 'reservation-commit',
    )
  const reservationsOf = (env: Env, variantId: string) =>
    read(env, (tx) => env.repos.inventoryReservation.findByVariant(tx, variantId))
  const historyOf = (env: Env, orderId: string) =>
    read(env, (tx) => env.repos.orderHistory.listByOrder(tx, orderId))
  const orderOf = async (env: Env, orderId: string) =>
    (await read(env, (tx) => env.repos.order.findById(tx, orderId)))!

  /** The sweeper's release after the TTL: the reservation row goes and its stock comes back. */
  async function expire(env: Env, variantId: string) {
    const [held] = await reservationsOf(env, variantId)
    await env.inventory.releaseReservation(held!.reservationId, 'expired')
  }

  function checkoutOver(
    env: Env,
    repos: Env['repos'],
    inventory: Env['inventory'] = env.inventory,
  ) {
    const logger = createLogger({ pretty: false, level: 'error' })
    return createCheckoutService({
      store: env.commandStore,
      repos,
      publisher: env.publisher,
      logger,
      cart: env.cart,
      orders: env.order,
      inventory,
      payments: createNativeStubPaymentsAdapter({ logger }),
      currency: 'GBP',
    })
  }

  // Defect: no_order returns without publishing, or publishes a non-empty order id.
  it('AC-6c: no order for the intent records one payment.failed with orderId "" and the reason no_order', async () => {
    const env = await setup()
    const result = await env.checkout.finalize('pi_unknown', { amountMinor: 500, currency: 'GBP' })
    expect(result).toEqual({ orderNumber: null, finalized: false, reason: 'no_order' })
    const failed = await events(env, EVT_PAYMENT_FAILED, '')
    expect(failed).toEqual([{ paymentId: 'pi_unknown', orderId: '', reason: 'no_order' }])
    await env.commandStore.close()
  })

  // Defect: the confirmed branch is dropped (a second delivery records order_not_pending: confirmed) or the status
  // test is skipped (a second delivery commits and publishes again).
  it('AC-6a: a second finalize for a confirmed order returns its number and changes nothing', async () => {
    const env = await setup()
    const { started, variants, paid, cartToken } = await placeOrder(env, [
      { priceMinor: 900, stock: 6, qty: 2 },
    ])
    const first = await env.checkout.finalize(started.paymentIntent.id, paid)
    const historyAfterFirst = await historyOf(env, started.orderId)
    const stockAfterFirst = await stockOf(env, variants[0]!.id)

    const second = await env.checkout.finalize(started.paymentIntent.id, paid)

    expect(second).toEqual(first)
    expect(second).toEqual({ orderNumber: started.orderNumber, finalized: true })
    // The first finalize's effects, each exactly once after both calls.
    expect(
      historyAfterFirst
        .filter((h) => h.toStatus === 'confirmed')
        .map((h) => [h.fromStatus, h.toStatus]),
    ).toEqual([['pending', 'confirmed']])
    expect(await events(env, EVT_PAYMENT_CAPTURED, started.orderId)).toEqual([
      {
        paymentId: started.paymentIntent.id,
        orderId: started.orderId,
        amountMinor: paid.amountMinor,
        currency: started.currency,
      },
    ])
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(1)
    expect(await events(env, EVT_CART_CONVERTED, started.orderId)).toEqual([
      { cartId: cartToken, orderId: started.orderId },
    ])
    const emptied = await payloads(
      env,
      EVT_CART_UPDATED,
      (p) => p.cartId === cartToken && p.itemCount === 0,
    )
    expect(emptied).toEqual([{ cartId: cartToken, itemCount: 0, totalMinor: 0 }])
    expect(await events(env, EVT_PAYMENT_FAILED, started.orderId)).toHaveLength(0)
    expect(await commitsOf(env, variants[0]!.id)).toHaveLength(1)
    expect(await stockOf(env, variants[0]!.id)).toBe(stockAfterFirst)
    expect(await historyOf(env, started.orderId)).toEqual(historyAfterFirst)
    await env.commandStore.close()
  })

  // Defect: the status check (step 2) runs after the amount check, or is dropped and left to step 5's conditional
  // write: a captured payment for a non-pending order is then reported as amount_mismatch or stock_unavailable.
  // Quarantined to the nightly project (vitest.config.ts): red then green with no code change, SQLITE_CONSTRAINT_PRIMARYKEY
  // on the cancelled order's refund row (its id is uuidv5 of the intent), about one run in fifty; the board row owns it.
  it.runIf(process.env['NYMBAL_NIGHTLY'])(
    'decision 4 check order: status is decided before amount, so a non-pending order never reports amount_mismatch',
    async () => {
      const env = await setup()
      const cancelled = await placeOrder(env, [{ priceMinor: 820, stock: 3, qty: 1 }])
      await env.checkout.cancel(cancelled.started.orderId, 'admin cancelled')
      const confirmed = await placeOrder(env, [{ priceMinor: 540, stock: 3, qty: 1 }])
      await env.checkout.finalize(confirmed.started.paymentIntent.id, confirmed.paid)
      // The cancelled leg's backstop refunds whatever amount it is handed; the provider answers it, so a generated amount
      // the stub would refuse still reaches the status check.
      const answering: PaymentsAdapter = {
        ...env.payments,
        async refund(paymentId, amountMinor, reason, opts) {
          return {
            refundId: `re_d4_${uuidv7()}`,
            paymentId,
            amountMinor: amountMinor ?? 0,
            currency: opts?.currency ?? 'GBP',
            reason: reason ?? null,
            status: 'succeeded',
          }
        },
      }
      const backstop = createCheckoutService({
        store: env.commandStore,
        repos: env.repos,
        publisher: env.publisher,
        logger: createLogger({ pretty: false, level: 'error' }),
        cart: env.cart,
        orders: env.order,
        inventory: env.inventory,
        payments: answering,
        currency: 'GBP',
      })

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 100_000 }),
          fc.constantFrom('GBP', 'usd'),
          async (amountMinor, currency) => {
            const wrongOrRight = { amountMinor, currency }
            expect(
              await backstop.finalize(cancelled.started.paymentIntent.id, wrongOrRight),
            ).toEqual({
              orderNumber: cancelled.started.orderNumber,
              finalized: false,
              reason: 'order_cancelled_refunded',
            })
            expect(
              await env.checkout.finalize(confirmed.started.paymentIntent.id, wrongOrRight),
            ).toEqual({ orderNumber: confirmed.started.orderNumber, finalized: true })
          },
        ),
        { numRuns: 15 },
      )
      expect(await events(env, EVT_ORDER_PAID, confirmed.started.orderId)).toHaveLength(1)
      expect(await events(env, EVT_ORDER_PAID, cancelled.started.orderId)).toHaveLength(0)
      expect((await orderOf(env, cancelled.started.orderId)).status).toBe('cancelled')
      await env.commandStore.close()
    },
  )

  // Defect: the status check is skipped, so a captured payment confirms a cancelled order and takes its stock.
  // P1-12 AC-12 (decision 11): the capture is refunded and recorded as order_cancelled_refunded.
  it('AC-6b: a captured payment for a cancelled order is order_cancelled_refunded, recorded, the order untouched', async () => {
    const env = await setup()
    const { started, variants, paid } = await placeOrder(env, [
      { priceMinor: 700, stock: 4, qty: 1 },
    ])
    await env.checkout.cancel(started.orderId, 'admin cancelled')
    // The shopper's payment lands after the cancel: the provider now holds the intent captured.
    await env.payments.capturePayment(started.paymentIntent.id)
    const stockBefore = await stockOf(env, variants[0]!.id)
    const historyBefore = await historyOf(env, started.orderId)
    const reason = 'order_cancelled_refunded'

    const result = await env.checkout.finalize(started.paymentIntent.id, paid)

    expect(result).toEqual({ orderNumber: started.orderNumber, finalized: false, reason })
    expect((await orderOf(env, started.orderId)).status).toBe('cancelled')
    expect(await stockOf(env, variants[0]!.id)).toBe(stockBefore)
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(0)
    expect(await events(env, EVT_PAYMENT_FAILED, started.orderId)).toEqual([
      { paymentId: started.paymentIntent.id, orderId: started.orderId, reason },
    ])
    const history = await historyOf(env, started.orderId)
    expect(history.length).toBe(historyBefore.length + 1)
    const note = history.find((h) => !historyBefore.some((b) => b.id === h.id))!
    expect(note.note).toContain(reason)
    expect(note.fromStatus).toBe(note.toStatus)
    expect(note.toStatus).toBe('cancelled')
    await env.commandStore.close()
  })

  // Defect: S007, finalize ignores the paid amount or currency; or `||` becomes `&&`, so a right amount in the
  // wrong currency confirms; or the currency compare is case-sensitive, so Stripe's lowercase `gbp` never confirms.
  it('AC-3: any paid amount other than the total, or any other currency, is amount_mismatch and leaves the order pending', async () => {
    const env = await setup()
    const { started, variants, paid } = await placeOrder(env, [
      { priceMinor: 1250, stock: 9, qty: 3 },
    ])
    const variantId = variants[0]!.id
    const due = started.totalMinor
    const stockBefore = await stockOf(env, variantId)
    const [held] = await reservationsOf(env, variantId)
    let calls = 0

    const tryPaid = async (amountMinor: number, currency: string) => {
      calls += 1
      const result = await env.checkout.finalize(started.paymentIntent.id, {
        amountMinor,
        currency,
      })
      expect(result).toEqual({
        orderNumber: started.orderNumber,
        finalized: false,
        reason: `amount_mismatch: paid ${amountMinor} ${currency.toUpperCase()}, due ${due} GBP`,
      })
    }
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 * due }).filter((a) => a !== due),
        fc.constantFrom('GBP', 'gbp'),
        tryPaid,
      ),
      { numRuns: 25 },
    )
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('USD', 'eur', 'JPY', 'gbx'), (c) => tryPaid(due, c)),
      { numRuns: 8 },
    )

    expect((await orderOf(env, started.orderId)).status).toBe('pending')
    expect(await stockOf(env, variantId)).toBe(stockBefore)
    expect(await reservationsOf(env, variantId)).toEqual([held])
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(0)
    expect(await events(env, EVT_PAYMENT_FAILED, started.orderId)).toHaveLength(calls)
    expect(
      (await historyOf(env, started.orderId)).filter((h) => h.note.includes('amount_mismatch')),
    ).toHaveLength(calls)

    // The same amount in the order's currency, in Stripe's lowercase, confirms.
    const confirmed = await env.checkout.finalize(started.paymentIntent.id, {
      amountMinor: paid.amountMinor,
      currency: paid.currency.toLowerCase(),
    })
    expect(confirmed).toEqual({ orderNumber: started.orderNumber, finalized: true })
    const [orderPaid] = await events(env, EVT_ORDER_PAID, started.orderId)
    expect(orderPaid?.amountMinor).toBe(due)
    expect(orderPaid?.currency).toBe(started.currency)
    expect(await stockOf(env, variantId)).toBe(stockBefore)
    expect(await commitsOf(env, variantId)).toHaveLength(1)
    await env.commandStore.close()
  })

  // Defect: a released reservation is committed as is (NotFoundError, Stripe retries for days), the re-take reads
  // the wrong line (index), or a re-take adds a second adjustment row.
  it('AC-11a: a late payment re-takes each released line and commits every line once', async () => {
    const env = await setup()
    const lines = [
      { priceMinor: 300, stock: 10, qty: 2 },
      { priceMinor: 450, stock: 8, qty: 3 },
    ]
    const { started, variants, paid } = await placeOrder(env, lines)
    await expire(env, variants[1]!.id)
    expect(await stockOf(env, variants[1]!.id)).toBe(lines[1]!.stock)

    const result = await env.checkout.finalize(started.paymentIntent.id, paid)

    expect(result).toEqual({ orderNumber: started.orderNumber, finalized: true })
    expect((await orderOf(env, started.orderId)).status).toBe('confirmed')
    for (const [i, variant] of variants.entries()) {
      expect(await stockOf(env, variant.id)).toBe(lines[i]!.stock - lines[i]!.qty)
      const commits = await commitsOf(env, variant.id)
      expect(commits.map((c) => c.adjustment)).toEqual([-lines[i]!.qty])
      expect(await reservationsOf(env, variant.id)).toHaveLength(0)
    }
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(1)
    await env.commandStore.close()
  })

  // Defect: StockUnavailable escapes as a 5xx, or the earlier lines' commit and re-take are not behind the savepoint,
  // so a refused late payment still takes and commits stock.
  it("AC-11b: when a released line's stock is gone, stock_unavailable is recorded and every earlier line is undone", async () => {
    const env = await setup()
    const lines = [
      { priceMinor: 200, stock: 5, qty: 1 },
      { priceMinor: 300, stock: 5, qty: 2 },
      { priceMinor: 400, stock: 3, qty: 3 },
    ]
    const { started, variants, paid } = await placeOrder(env, lines)
    const [held, retakable, gone] = variants as [
      (typeof variants)[0],
      (typeof variants)[0],
      (typeof variants)[0],
    ]
    await expire(env, retakable.id)
    await expire(env, gone.id)
    await env.inventory.reserveStock(gone.id, lines[2]!.stock, 'another-order')
    const before = await Promise.all(variants.map((v) => stockOf(env, v.id)))
    const heldBefore = await reservationsOf(env, held.id)
    const reason = `stock_unavailable: ${gone.id}`

    const result = await env.checkout.finalize(started.paymentIntent.id, paid)

    expect(result).toEqual({ orderNumber: started.orderNumber, finalized: false, reason })
    expect((await orderOf(env, started.orderId)).status).toBe('pending')
    expect(await Promise.all(variants.map((v) => stockOf(env, v.id)))).toEqual(before)
    expect(await reservationsOf(env, held.id)).toEqual(heldBefore)
    expect(await reservationsOf(env, retakable.id)).toHaveLength(0)
    expect((await reservationsOf(env, gone.id)).map((r) => r.orderRef)).toEqual(['another-order'])
    for (const v of variants) expect(await commitsOf(env, v.id)).toHaveLength(0)
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(0)
    expect(await events(env, EVT_PAYMENT_FAILED, started.orderId)).toEqual([
      { paymentId: started.paymentIntent.id, orderId: started.orderId, reason },
    ])
    expect(
      (await historyOf(env, started.orderId)).filter((h) => h.note.includes(reason)),
    ).toHaveLength(1)
    await env.commandStore.close()
  })

  // Defect: the re-take's NotFoundError for a variant deleted since checkout escapes as a 5xx (Stripe retries for
  // days), or the reason names the wrong line's variant.
  it('AC-11b: a late payment whose variant was deleted after its release is stock_unavailable for that variant, the order pending', async () => {
    const env = await setup()
    const lines = [
      { priceMinor: 300, stock: 6, qty: 1 },
      { priceMinor: 500, stock: 6, qty: 2 },
    ]
    const { started, variants, paid } = await placeOrder(env, lines)
    const [kept, deleted] = variants as [(typeof variants)[0], (typeof variants)[0]]
    await expire(env, kept.id)
    await expire(env, deleted.id)
    await env.commandStore.transaction((tx) => env.repos.variant.delete(tx, deleted.id))
    const keptStockBefore = await stockOf(env, kept.id)
    const reason = `stock_unavailable: ${deleted.id}`

    const result = await env.checkout.finalize(started.paymentIntent.id, paid)

    expect(result).toEqual({ orderNumber: started.orderNumber, finalized: false, reason })
    expect((await orderOf(env, started.orderId)).status).toBe('pending')
    expect(await events(env, EVT_PAYMENT_FAILED, started.orderId)).toEqual([
      { paymentId: started.paymentIntent.id, orderId: started.orderId, reason },
    ])
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(0)
    // The earlier line's re-take is undone with the refusal.
    expect(await stockOf(env, kept.id)).toBe(keptStockBefore)
    expect(await reservationsOf(env, kept.id)).toHaveLength(0)
    expect(await commitsOf(env, kept.id)).toHaveLength(0)
    await env.commandStore.close()
  })

  // Defect: the re-take's catch swallows every error as stock_unavailable, so a store fault is recorded as a
  // refused payment (payment.failed, a history note) instead of failing the delivery for Stripe to retry.
  it('decision 5: a re-take that fails with anything but NotFoundError rejects with that error and records nothing', async () => {
    const env = await setup()
    const { started, variants, paid } = await placeOrder(env, [
      { priceMinor: 400, stock: 5, qty: 2 },
    ])
    await expire(env, variants[0]!.id)
    const historyBefore = await historyOf(env, started.orderId)
    const fault = new Error('database is locked')
    const inventory: Env['inventory'] = {
      ...env.inventory,
      async tryReserveStock() {
        throw fault
      },
    }

    await expect(
      checkoutOver(env, env.repos, inventory).finalize(started.paymentIntent.id, paid),
    ).rejects.toBe(fault)

    expect((await orderOf(env, started.orderId)).status).toBe('pending')
    expect(await events(env, EVT_PAYMENT_FAILED, started.orderId)).toHaveLength(0)
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(0)
    expect(await historyOf(env, started.orderId)).toEqual(historyBefore)
    await env.commandStore.close()
  })

  // Defect: a reservation id with no order line reads `undefined.variantId` (a TypeError) or is recorded as an
  // outcome; it is a data fault, so it throws finalize_failed and records nothing.
  it('decision 5: a released reservation with no matching order line throws finalize_failed and records nothing', async () => {
    const env = await setup()
    const intent = `pi_orphan_${uuidv7().slice(-8)}`
    const order = await env.order.createFromCheckout({
      orderId: uuidv7(),
      customerId: null,
      email: 'orphan@test.com',
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
      lineItems: [],
      subtotalMinor: 0,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 0,
      currency: 'GBP',
      metadata: { reservationIds: [uuidv7()] },
    })
    await env.commandStore.transaction((tx) =>
      env.repos.order.setPaymentIntent(tx, order.id, intent, new Date()),
    )

    await expect(
      env.checkout.finalize(intent, { amountMinor: 0, currency: 'GBP' }),
    ).rejects.toMatchObject({ code: 'checkout.finalize_failed' })
    expect((await orderOf(env, order.id)).status).toBe('pending')
    expect(await events(env, EVT_PAYMENT_FAILED, order.id)).toHaveLength(0)
    expect(await events(env, EVT_ORDER_PAID, order.id)).toHaveLength(0)
    await env.commandStore.close()
  })

  /**
   * A writer that moves the order after finalize has read it pending and before its conditional write: the read
   * returns the pending snapshot, then the concurrent writer's status change lands, so setStatusIf changes 0 rows.
   */
  function raceAfterRead(
    env: Env,
    winnerStatus: 'confirmed' | 'cancelled',
    /** More of the winner's work, in the same write: e.g. taking the stock its confirm needed. */
    winnerAlso: () => Promise<void> = async () => {},
  ) {
    let raced = false
    const order: Env['repos']['order'] = {
      ...env.repos.order,
      async findByPaymentIntentId(tx, paymentIntentId) {
        const snapshot = await env.repos.order.findByPaymentIntentId(tx, paymentIntentId)
        if (snapshot !== null && !raced) {
          raced = true
          // Joins finalize's open transaction ahead of its savepoint, so the winner's write survives its rollback.
          await env.commandStore.transaction(async (wtx) => {
            await winnerAlso()
            await env.repos.order.setStatusIf(wtx, snapshot.id, 'pending', winnerStatus, new Date())
          })
        }
        return snapshot
      },
    }
    return checkoutOver(env, { ...env.repos, order })
  }

  // Defect: an unconditional pending → confirmed write (a second order.paid and history entry), the lost race
  // rethrown as a 5xx, the race's commits kept (no savepoint), or the stale snapshot used instead of a re-read.
  it('AC-12: a delivery that loses the race to a confirming writer returns the order number and adds nothing', async () => {
    const env = await setup()
    const { started, variants, paid } = await placeOrder(env, [
      { priceMinor: 650, stock: 4, qty: 2 },
    ])
    const heldBefore = await reservationsOf(env, variants[0]!.id)
    const historyBefore = (await historyOf(env, started.orderId)).length

    const result = await raceAfterRead(env, 'confirmed').finalize(started.paymentIntent.id, paid)

    expect(result).toEqual({ orderNumber: started.orderNumber, finalized: true })
    expect((await orderOf(env, started.orderId)).status).toBe('confirmed')
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(0)
    expect(await events(env, EVT_PAYMENT_FAILED, started.orderId)).toHaveLength(0)
    expect(await reservationsOf(env, variants[0]!.id)).toEqual(heldBefore)
    expect(await commitsOf(env, variants[0]!.id)).toHaveLength(0)
    expect((await historyOf(env, started.orderId)).length).toBe(historyBefore)
    await env.commandStore.close()
  })

  // Defect: the loser's re-take fails because the winner took the last units, and stock_unavailable is recorded
  // against its stale pending snapshot, so one captured payment ends in order.paid and payment.failed together.
  it('AC-12: a delivery that loses the race to a confirming writer that took the last units returns the order number and records no payment.failed', async () => {
    const env = await setup()
    const qty = 2
    const { started, variants, paid } = await placeOrder(env, [
      { priceMinor: 650, stock: qty, qty },
    ])
    const variantId = variants[0]!.id
    await expire(env, variantId)
    expect(await stockOf(env, variantId)).toBe(qty)
    const historyBefore = (await historyOf(env, started.orderId)).length

    const loser = raceAfterRead(env, 'confirmed', async () => {
      const taken = await env.inventory.tryReserveStock(variantId, qty, started.orderId)
      await env.inventory.commitReservation(taken!.reservationId, 'system:winner')
    })
    const result = await loser.finalize(started.paymentIntent.id, paid)

    expect(result).toEqual({ orderNumber: started.orderNumber, finalized: true })
    expect((await orderOf(env, started.orderId)).status).toBe('confirmed')
    expect(await events(env, EVT_PAYMENT_FAILED, started.orderId)).toEqual([])
    expect((await historyOf(env, started.orderId)).length).toBe(historyBefore)
    // The winner's take is the only one: stock went from qty to 0 once.
    expect(await stockOf(env, variantId)).toBe(qty - qty)
    expect(await commitsOf(env, variantId)).toHaveLength(1)
    await env.commandStore.close()
  })

  // Defect: the lost race confirms anyway, or records the snapshot's status (pending) instead of the one re-read.
  it('AC-12: a delivery that loses the race to a cancel records order_cancelled_refunded and undoes its commits', async () => {
    const env = await setup()
    const { started, variants, paid } = await placeOrder(env, [
      { priceMinor: 650, stock: 4, qty: 2 },
    ])
    const heldBefore = await reservationsOf(env, variants[0]!.id)
    const reason = 'order_cancelled_refunded'

    const result = await raceAfterRead(env, 'cancelled').finalize(started.paymentIntent.id, paid)

    expect(result).toEqual({ orderNumber: started.orderNumber, finalized: false, reason })
    expect((await orderOf(env, started.orderId)).status).toBe('cancelled')
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(0)
    expect(await events(env, EVT_PAYMENT_FAILED, started.orderId)).toEqual([
      { paymentId: started.paymentIntent.id, orderId: started.orderId, reason },
    ])
    expect(await reservationsOf(env, variants[0]!.id)).toEqual(heldBefore)
    expect(await commitsOf(env, variants[0]!.id)).toHaveLength(0)
    const notes = (await historyOf(env, started.orderId)).filter((h) => h.note.includes(reason))
    expect(notes.map((n) => [n.fromStatus, n.toStatus])).toEqual([['cancelled', 'cancelled']])
    await env.commandStore.close()
  })
})

describe('CheckoutService.beginCheckout: P1-12 decisions 2, 6, 10, 11 and review B1, M2, M3', () => {
  type Env = Awaited<ReturnType<typeof setup>>
  type Line = { priceMinor: number; stock: number; qty: number }
  const logger = createLogger({ pretty: false, level: 'error' })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The stub provider, with what checkout asked of it recorded and any call replaced. */
  function provider(over: (stub: PaymentsAdapter) => Partial<PaymentsAdapter> = () => ({})) {
    const stub = createNativeStubPaymentsAdapter({ logger })
    const o = over(stub)
    const calls = {
      created: [] as PaymentIntentParams[],
      cancelled: [] as string[],
      refunded: [] as string[],
    }
    const payments: PaymentsAdapter = {
      ...stub,
      ...o,
      async createPaymentIntent(params) {
        calls.created.push(params)
        return (o.createPaymentIntent ?? stub.createPaymentIntent)(params)
      },
      async cancelPaymentIntent(id) {
        calls.cancelled.push(id)
        return (o.cancelPaymentIntent ?? stub.cancelPaymentIntent)(id)
      },
      async refund(id, amountMinor, reason) {
        calls.refunded.push(id)
        return stub.refund(id, amountMinor, reason)
      },
    }
    return { stub, payments, calls }
  }

  function checkoutWith(env: Env, payments: PaymentsAdapter, repos: Env['repos'] = env.repos) {
    return createCheckoutService({
      store: env.commandStore,
      repos,
      publisher: env.publisher,
      logger,
      cart: env.cart,
      orders: env.order,
      inventory: env.inventory,
      payments,
      currency: 'GBP',
    })
  }

  async function cartWith(env: Env, lines: Line[]) {
    const tag = uuidv7().slice(-8)
    const product = await env.product.create({
      slug: `begin-${tag}`,
      name: `Begin ${tag}`,
      status: 'active',
      variants: lines.map((l, i) => ({
        sku: `BEG-${tag}-${i}`,
        name: `V${i}`,
        priceMinor: l.priceMinor,
        stock: l.stock,
        lowStockThreshold: 0,
        options: [],
      })),
    })
    const cart = await env.cart.getOrCreate()
    for (const [i, variant] of product.variants.entries()) {
      await env.cart.addItem(cart.token, {
        variantId: variant.id,
        productId: product.id,
        productName: product.name,
        variantName: variant.name,
        priceMinor: variant.priceMinor,
        imageUrl: '',
        qty: lines[i]!.qty,
      })
    }
    return { token: cart.token, product, variants: product.variants }
  }

  type Checkout = ReturnType<typeof createCheckoutService>
  /** `+stub-pending` unless asked otherwise: the intent waits for the shopper. */
  const begin = (
    checkout: Checkout,
    cartToken: string,
    opts: { email?: string; customerId?: string } = {},
  ) =>
    checkout.beginCheckout({
      cartToken,
      email: opts.email ?? 'shopper+stub-pending@example.com',
      ...(opts.customerId !== undefined && { customerId: opts.customerId }),
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
    })

  const orderOf = async (env: Env, orderId: string) =>
    (await env.commandStore.read((tx) => env.repos.order.findById(tx, orderId)))!
  const stockOf = async (env: Env, variantId: string) =>
    (await env.commandStore.read((tx) => env.repos.variant.findById(tx, variantId)))!.stock
  async function events(env: Env, type: string, orderId: string) {
    const all = await env.commandStore.read((tx) => env.repos.eventLog.listAll(tx))
    return all
      .map((l) => l.event)
      .filter((e) => e.type === type)
      .map((e) => e.payload as Record<string, unknown>)
      .filter((p) => p.orderId === orderId || (p.order as { id?: string })?.id === orderId)
  }

  const STATUSES: PaymentStatus[] = [
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'requires_capture',
    'succeeded',
    'cancelled',
    'failed',
  ]
  const expectedOutcome = (s: PaymentStatus) =>
    s === 'succeeded'
      ? 'succeeded'
      : s === 'failed' || s === 'cancelled'
        ? 'failed'
        : 'requires_action'
  const orderStatusFor = {
    succeeded: 'confirmed',
    failed: 'cancelled',
    requires_action: 'pending',
  } as const

  // Defect: a status mapped to the wrong outcome (a cancelled intent left pending, a `processing` one confirmed), the
  // answer's orderStatus taken from the T1 snapshot instead of the store, or a failed intent's stock kept.
  it('decision 2: every intent status at creation maps to its payment outcome, and the answer is the stored order', async () => {
    const line = { priceMinor: 700, stock: 5, qty: 2 }
    for (const status of STATUSES) {
      const env = await setup()
      const { payments } = provider((stub) => ({
        async createPaymentIntent(params) {
          return { ...(await stub.createPaymentIntent(params)), status }
        },
      }))
      const { token, variants } = await cartWith(env, [line])
      const started = await begin(checkoutWith(env, payments), token)
      const outcome = expectedOutcome(status)
      const stored = await orderOf(env, started.orderId)

      const failed = outcome === 'failed'
      const reason = `payment_${status}`

      expect({ status, payment: started.payment }).toEqual({
        status,
        payment: failed ? { status: outcome, reason } : { status: outcome },
      })
      expect(started.orderStatus).toBe(stored.status)
      expect(stored.status).toBe(orderStatusFor[outcome])
      // Stock held (or committed) for a live order, back in full for a cancelled one.
      const held = failed ? 0 : line.qty
      expect(await stockOf(env, variants[0]!.id)).toBe(line.stock - held)
      // payment.failed only for an intent that failed at creation, with its reason.
      expect((await events(env, EVT_PAYMENT_FAILED, started.orderId)).map((p) => p.reason)).toEqual(
        failed ? [reason] : [],
      )
      await env.commandStore.close()
    }
  })

  // Defect: the intent params lose the total, the receipt email the stub's triggers read, or the customer id (or send
  // `customerId: null` to the provider for a guest).
  it('decision 7: the intent is for the order total and receipt email, with a customer id only for a customer', async () => {
    const env = await setup()
    const { payments, calls } = provider()
    const checkout = checkoutWith(env, payments)
    const a = await cartWith(env, [{ priceMinor: 450, stock: 5, qty: 3 }])
    const customerId = uuidv7()
    const forCustomer = await begin(checkout, a.token, { customerId })
    const b = await cartWith(env, [{ priceMinor: 450, stock: 5, qty: 1 }])
    const guest = await begin(checkout, b.token)

    expect(calls.created.map((p) => p.amountMinor)).toEqual([
      forCustomer.totalMinor,
      guest.totalMinor,
    ])
    expect(calls.created[0]!.receiptEmail).toBe('shopper+stub-pending@example.com')
    expect(calls.created[0]!.customerId).toBe(customerId)
    expect('customerId' in calls.created[1]!).toBe(false)
    await env.commandStore.close()
  })

  // Defect: a resubmit makes a second intent or order, reserves the lines again, or answers without the intent.
  it('decision 6: a resubmit of the same cart answers its pending order and intent, and reserves, creates and publishes nothing', async () => {
    const env = await setup()
    const { payments, calls } = provider()
    const checkout = checkoutWith(env, payments)
    const line = { priceMinor: 800, stock: 6, qty: 2 }
    const { token, variants } = await cartWith(env, [line])
    const first = await begin(checkout, token)
    const placedBefore = await events(env, EVT_ORDER_PLACED, first.orderId)

    const again = await begin(checkout, token)

    expect(again.orderId).toBe(first.orderId)
    expect(again.paymentIntent.id).toBe(first.paymentIntent.id)
    expect(again.payment).toEqual({ status: 'requires_action' })
    expect(again.orderStatus).toBe('pending')
    expect(calls.created).toHaveLength(1)
    expect(await stockOf(env, variants[0]!.id)).toBe(line.stock - line.qty)
    expect(await events(env, EVT_ORDER_PLACED, first.orderId)).toHaveLength(placedBefore.length)
    await env.commandStore.close()
  })

  // Defect: answerExisting reports the provider's `succeeded` as the checkout's, though only finalize confirms.
  it('M3: a resubmit whose intent the provider has since captured answers requires_action and leaves the order pending', async () => {
    const env = await setup()
    const { stub, payments } = provider()
    const checkout = checkoutWith(env, payments)
    const { token } = await cartWith(env, [{ priceMinor: 300, stock: 4, qty: 1 }])
    const first = await begin(checkout, token)
    await stub.capturePayment(first.paymentIntent.id)

    const again = await begin(checkout, token)

    expect(again.orderId).toBe(first.orderId)
    expect(again.paymentIntent.status).toBe('succeeded')
    expect(again.payment).toEqual({ status: 'requires_action' })
    expect(again.orderStatus).toBe('pending')
    expect((await orderOf(env, first.orderId)).status).toBe('pending')
    await env.commandStore.close()
  })

  // Defect: a resubmit answers an order whose intent can never be paid (the cart is stranded), cancels it through the
  // provider again, or leaves its reservation held beside the new one.
  it('M3: a resubmit whose intent the provider failed or cancelled cancels that order with payment_<status> and places a fresh one', async () => {
    for (const closedStatus of ['failed', 'cancelled'] as const) {
      const env = await setup()
      let closedId = ''
      const { payments, calls } = provider((stub) => ({
        async getPaymentIntent(id) {
          const intent = await stub.getPaymentIntent(id)
          return id === closedId ? { ...intent, status: closedStatus } : intent
        },
      }))
      const checkout = checkoutWith(env, payments)
      const line = { priceMinor: 300, stock: 4, qty: 1 }
      const { token, variants } = await cartWith(env, [line])
      const first = await begin(checkout, token)
      closedId = first.paymentIntent.id

      const again = await begin(checkout, token)

      expect(again.orderId).not.toBe(first.orderId)
      expect(again.paymentIntent.id).not.toBe(first.paymentIntent.id)
      expect(again.orderStatus).toBe('pending')
      expect((await orderOf(env, first.orderId)).status).toBe('cancelled')
      expect((await events(env, EVT_ORDER_CANCELLED, first.orderId)).map((p) => p.reason)).toEqual([
        `payment_${closedStatus}`,
      ])
      expect(calls.cancelled).toEqual([])
      expect(calls.created).toHaveLength(2)
      // One order's worth held: the closed order's release and the fresh order's reserve.
      expect(await stockOf(env, variants[0]!.id)).toBe(line.stock - line.qty)
      await env.commandStore.close()
    }
  })

  type Edit = {
    name: string
    lines: Line[]
    edit: (env: Env, token: string, ids: string[]) => Promise<void>
  }
  const edits: Edit[] = [
    {
      name: 'quantities swapped at the same total',
      lines: [
        { priceMinor: 100, stock: 9, qty: 1 },
        { priceMinor: 100, stock: 9, qty: 2 },
      ],
      async edit(env, token, [a, b]) {
        await env.cart.updateItemQuantity(token, a!, 2)
        await env.cart.updateItemQuantity(token, b!, 1)
      },
    },
    {
      name: 'lines reordered at the same quantities and total',
      lines: [
        { priceMinor: 100, stock: 9, qty: 1 },
        { priceMinor: 100, stock: 9, qty: 1 },
      ],
      async edit(env, token, [a]) {
        const c = (await env.cart.get(token))!
        const item = c.items.find((i) => i.variantId === a)!
        await env.cart.removeItem(token, a!)
        await env.cart.addItem(token, item)
      },
    },
    {
      name: 'unit prices swapped at the same total',
      lines: [
        { priceMinor: 100, stock: 9, qty: 1 },
        { priceMinor: 200, stock: 9, qty: 1 },
      ],
      async edit(env, token) {
        const c = (await env.commandStore.read((tx) => env.repos.cart.findByToken(tx, token)))!
        const [x, y] = c.items
        await env.commandStore.transaction((tx) =>
          env.repos.cart.put(tx, {
            ...c,
            items: [
              { ...x!, priceMinor: y!.priceMinor },
              { ...y!, priceMinor: x!.priceMinor },
            ],
          }),
        )
      },
    },
    {
      name: 'a free line removed at the same total',
      lines: [
        { priceMinor: 250, stock: 9, qty: 1 },
        { priceMinor: 0, stock: 9, qty: 1 },
      ],
      async edit(env, token, [, free]) {
        await env.cart.removeItem(token, free!)
      },
    },
    {
      name: 'a quantity raised',
      lines: [{ priceMinor: 150, stock: 9, qty: 1 }],
      async edit(env, token, [a]) {
        await env.cart.updateItemQuantity(token, a!, 3)
      },
    },
  ]

  // Defect: sameLines ignores one of variant, quantity, unit price, line count or total, so a changed cart is answered
  // with the old order and intent; or the old intent is not cancelled first (money stranded on a cancelled order).
  for (const e of edits) {
    it(`decision 11: a changed cart (${e.name}) cancels the old intent, then the old order, and places one for the new lines`, async () => {
      const env = await setup()
      const { payments, calls } = provider()
      const checkout = checkoutWith(env, payments)
      const { token, variants } = await cartWith(env, e.lines)
      const first = await begin(checkout, token)
      await e.edit(
        env,
        token,
        variants.map((v) => v.id),
      )

      const again = await begin(checkout, token)

      expect(again.orderId).not.toBe(first.orderId)
      expect(calls.cancelled).toEqual([first.paymentIntent.id])
      expect((await orderOf(env, first.orderId)).status).toBe('cancelled')
      expect((await events(env, EVT_ORDER_CANCELLED, first.orderId)).map((p) => p.reason)).toEqual([
        'superseded: the cart changed',
      ])
      const cart = (await env.commandStore.read((tx) => env.repos.cart.findByToken(tx, token)))!
      const placed = await orderOf(env, again.orderId)
      expect(placed.lineItems.map((l) => [l.variantId, l.qty, l.unitPriceMinor])).toEqual(
        cart.items.map((i) => [i.variantId, i.qty, i.priceMinor]),
      )
      expect(again.totalMinor).toBe(cart.subtotalMinor)
      // Only the new order's quantities are held.
      for (const v of variants) {
        const qty = cart.items.find((i) => i.variantId === v.id)?.qty ?? 0
        expect(await stockOf(env, v.id)).toBe(v.stock - qty)
      }
      await env.commandStore.close()
    })
  }

  // Defect: a refused cancel is ignored and the old order cancelled anyway (its capture then lands on a cancelled
  // order), or any provider error is reported as payment_in_progress.
  it('decision 11: a provider that refuses the cancel answers payment_in_progress naming the old order, and nothing changes', async () => {
    const env = await setup()
    const { payments, calls } = provider(() => ({
      async cancelPaymentIntent(id) {
        throw new PaymentError('cancel_refused', `intent ${id} is processing`)
      },
    }))
    const checkout = checkoutWith(env, payments)
    const line = { priceMinor: 500, stock: 6, qty: 1 }
    const { token, variants } = await cartWith(env, [line])
    const first = await begin(checkout, token)
    await env.cart.updateItemQuantity(token, variants[0]!.id, 2)

    await expect(begin(checkout, token)).rejects.toMatchObject({
      code: 'checkout.payment_in_progress',
      context: { orderNumber: first.orderNumber },
    })
    expect((await orderOf(env, first.orderId)).status).toBe('pending')
    expect(calls.created).toHaveLength(1)
    expect(await stockOf(env, variants[0]!.id)).toBe(line.stock - line.qty)
    await env.commandStore.close()
  })

  it('decision 11: any other provider error on the cancel is rethrown as it is, and nothing changes', async () => {
    const env = await setup()
    const { payments } = provider(() => ({
      async cancelPaymentIntent() {
        throw new PaymentError('intent_failed', 'provider unreachable')
      },
    }))
    const checkout = checkoutWith(env, payments)
    const line = { priceMinor: 500, stock: 6, qty: 1 }
    const { token, variants } = await cartWith(env, [line])
    const first = await begin(checkout, token)
    await env.cart.updateItemQuantity(token, variants[0]!.id, 2)

    await expect(begin(checkout, token)).rejects.toMatchObject({ code: 'payment.intent_failed' })
    expect((await orderOf(env, first.orderId)).status).toBe('pending')
    expect(await stockOf(env, variants[0]!.id)).toBe(line.stock - line.qty)
    await env.commandStore.close()
  })

  // Defect: a checkout that meets a newer changed order after every cancel loops for good, or gives up before trying.
  it('decision 11: a checkout that keeps meeting a newer changed order gives up with in_progress after a bounded number of cancels', async () => {
    const env = await setup()
    const { payments, calls } = provider()
    const { token } = await cartWith(env, [{ priceMinor: 400, stock: 5, qty: 1 }])
    const first = await begin(checkoutWith(env, payments), token)
    const real = await orderOf(env, first.orderId)
    let n = 0
    // A busier writer: each pass under the lock finds a newer pending order for other lines, with its own intent.
    const order: Env['repos']['order'] = {
      ...env.repos.order,
      async findPendingByCartToken() {
        n += 1
        return { ...real, paymentIntentId: `pi_busier_${n}`, totalMinor: real.totalMinor + n }
      },
    }
    const checkout = checkoutWith(env, payments, { ...env.repos, order })

    await expect(begin(checkout, token)).rejects.toMatchObject({ code: 'checkout.in_progress' })
    expect(calls.cancelled.length).toBeGreaterThanOrEqual(1)
    expect(calls.cancelled.length).toBeLessThan(10)
    expect(calls.created).toHaveLength(1)
    await env.commandStore.close()
  })

  /** A pending order with no intent: T2 failed after the provider made the intent. */
  async function strandedOrder(env: Env, token: string) {
    const { payments } = provider()
    const failing: Env['repos']['order'] = {
      ...env.repos.order,
      async setPaymentIntent() {
        throw new Error('T2 lost')
      },
    }
    await expect(
      begin(checkoutWith(env, payments, { ...env.repos, order: failing }), token),
    ).rejects.toThrow('T2 lost')
    const pending = await env.commandStore.read((tx) =>
      env.repos.order.findPendingByCartToken(tx, token),
    )
    expect(pending?.paymentIntentId).toBeNull()
    return pending!
  }

  // Defect: a stranded order holds its cart at in_progress for good (B1), or a young one is taken as abandoned and a
  // second intent made while the first checkout is between T1 and T2.
  it('B1: a pending order without an intent holds the cart at in_progress for 120 s, then is cancelled as abandoned and replaced', async () => {
    const env = await setup()
    const line = { priceMinor: 650, stock: 5, qty: 2 }
    const { token, variants } = await cartWith(env, [line])
    const stranded = await strandedOrder(env, token)
    const placedAt = Date.parse(stranded.createdAt)
    const { payments, calls } = provider()
    const checkout = checkoutWith(env, payments)

    const now = vi.spyOn(Date, 'now').mockReturnValue(placedAt + 120_000)
    await expect(begin(checkout, token)).rejects.toMatchObject({ code: 'checkout.in_progress' })
    expect(calls.created).toHaveLength(0)
    expect((await orderOf(env, stranded.id)).status).toBe('pending')

    now.mockReturnValue(placedAt + 120_001)
    const again = await begin(checkout, token)

    expect(again.orderId).not.toBe(stranded.id)
    expect(calls.created).toHaveLength(1)
    expect((await orderOf(env, stranded.id)).status).toBe('cancelled')
    expect((await events(env, EVT_ORDER_CANCELLED, stranded.id)).map((p) => p.reason)).toEqual([
      'abandoned: no payment intent',
    ])
    expect(await stockOf(env, variants[0]!.id)).toBe(line.stock - line.qty)
    await env.commandStore.close()
  })

  // Defect: an intent the provider failed to make leaves a pending order with no intent behind (the cart then answers
  // in_progress), or its stock held.
  it('decision 10: an intent the provider fails to create cancels the draft and releases its stock, so the cart can check out again', async () => {
    const env = await setup()
    let fail = true
    const { payments, calls } = provider((stub) => ({
      async createPaymentIntent(params) {
        if (fail) throw new PaymentError('intent_failed', 'provider down')
        return stub.createPaymentIntent(params)
      },
    }))
    const checkout = checkoutWith(env, payments)
    const line = { priceMinor: 650, stock: 5, qty: 2 }
    const { token, variants } = await cartWith(env, [line])

    await expect(begin(checkout, token)).rejects.toMatchObject({ code: 'payment.intent_failed' })
    expect(await stockOf(env, variants[0]!.id)).toBe(line.stock)
    const orphan = calls.created[0]!.orderRef!
    expect((await orderOf(env, orphan)).status).toBe('cancelled')

    fail = false
    const again = await begin(checkout, token)
    expect(again.orderId).not.toBe(orphan)
    expect(await stockOf(env, variants[0]!.id)).toBe(line.stock - line.qty)
    await env.commandStore.close()
  })

  // Defect: an inline capture that finalize did not confirm is left on a pending order, neither attached nor refunded,
  // or the answer still says pending.
  it('M2: an inline capture that finalize does not confirm is refunded, the order cancelled and its stock released', async () => {
    const env = await setup()
    const { payments, calls } = provider((stub) => ({
      async createPaymentIntent(params) {
        // The provider captured more than the order's total, and holds that capture to refund.
        const intent = await stub.createPaymentIntent({
          ...params,
          amountMinor: params.amountMinor + 1,
        })
        return { ...intent, status: 'succeeded' }
      },
    }))
    const line = { priceMinor: 650, stock: 5, qty: 2 }
    const { token, variants } = await cartWith(env, [line])

    const started = await begin(checkoutWith(env, payments), token, { email: 'paid@example.com' })

    expect(calls.refunded).toEqual([started.paymentIntent.id])
    expect(started.orderStatus).toBe('cancelled')
    expect((await orderOf(env, started.orderId)).status).toBe('cancelled')
    expect(started.payment.status).toBe('failed')
    expect(started.payment.reason).toMatch(/^amount_mismatch: /)
    expect(await stockOf(env, variants[0]!.id)).toBe(line.stock)
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(0)
    await env.commandStore.close()
  })

  // Defect: an emptied cart's 409 names no order (the template cannot go to it), or names a later cancelled order
  // instead of the one the cart became.
  it("decision 6: an emptied cart's cart_empty names the order it became, never a later cancelled one", async () => {
    const env = await setup()
    const { payments } = provider()
    const checkout = checkoutWith(env, payments)
    const { token, variants, product } = await cartWith(env, [
      { priceMinor: 900, stock: 9, qty: 1 },
    ])
    const neverOrdered = await env.cart.getOrCreate()
    await expect(begin(checkout, neverOrdered.token)).rejects.toSatisfy(
      (err: unknown) => err instanceof CheckoutError && err.context?.orderNumber === undefined,
    )

    const confirmed = await begin(checkout, token, { email: 'paid@example.com' })
    expect(confirmed.orderStatus).toBe('confirmed')
    const v = variants[0]!
    await env.cart.addItem(token, {
      variantId: v.id,
      productId: product.id,
      productName: product.name,
      variantName: v.name,
      priceMinor: v.priceMinor,
      imageUrl: '',
      qty: 1,
    })
    const declined = await begin(checkout, token, { email: 'shopper+stub-decline@example.com' })
    expect(declined.orderStatus).toBe('cancelled')
    await env.cart.removeItem(token, v.id)

    await expect(begin(checkout, token)).rejects.toMatchObject({
      code: 'checkout.cart_empty',
      context: { orderNumber: confirmed.orderNumber },
    })
    await env.commandStore.close()
  })
})

function makeAddr() {
  return {
    firstName: 'Test',
    lastName: 'User',
    addressLine1: '1 Test St',
    city: 'London',
    region: 'England',
    postalCode: 'E1 1AA',
    country: 'GB',
  }
}

// P1-13 (spec P1-13-admin-truth-about-money): decision 2's mark-paid as a manual capture through `confirm` (B4) that
// first closes the order's intent (diff review B1), the backstop that refunds a provider capture of an order already
// paid outside the provider, the cancelled-capture refund recorded before the provider is asked (diff review M3), and
// `refundCapture`'s mapping of the provider's outcome. The integration suites pin these through the routes; Stryker
// mutates this file against the unit project only.
describe('CheckoutService: P1-13 mark-paid, the duplicate-capture backstop and the cancelled-capture refund', () => {
  type Env = Awaited<ReturnType<typeof setup>>
  type Line = { priceMinor: number; stock: number; qty: number }
  const logger = createLogger({ pretty: false, level: 'silent' })

  interface RefundCall {
    paymentId: string
    amountMinor: number | undefined
    reason: string | undefined
    opts: RefundOptions | undefined
  }
  const echo = async (c: RefundCall): Promise<Refund> => ({
    refundId: `re_${uuidv7()}`,
    paymentId: c.paymentId,
    amountMinor: c.amountMinor ?? 0,
    currency: c.opts?.currency ?? 'GBP',
    reason: c.reason ?? null,
    status: 'succeeded',
  })
  const failing = (err: Error) => async (): Promise<Refund> => {
    throw err
  }

  /** The stub provider with its refunds and cancels scripted and recorded. */
  function withProvider(env: Env, inventory: Env['inventory'] = env.inventory) {
    const stub = createNativeStubPaymentsAdapter({ logger })
    const script = {
      refund: echo as (c: RefundCall) => Promise<Refund>,
      cancel: (id: string) => stub.cancelPaymentIntent(id),
    }
    const calls = { refunds: [] as RefundCall[], cancelled: [] as string[] }
    const payments: PaymentsAdapter = {
      ...stub,
      async refund(paymentId, amountMinor, reason, opts) {
        const call = { paymentId, amountMinor, reason, opts }
        calls.refunds.push(call)
        return script.refund(call)
      },
      async cancelPaymentIntent(id) {
        calls.cancelled.push(id)
        return script.cancel(id)
      },
    }
    const checkout = createCheckoutService({
      store: env.commandStore,
      repos: env.repos,
      publisher: env.publisher,
      logger,
      cart: env.cart,
      orders: env.order,
      inventory,
      payments,
      currency: 'GBP',
    })
    return { stub, script, calls, checkout }
  }
  type Provider = ReturnType<typeof withProvider>

  /** A pending order whose intent waits for the shopper (`+stub-pending`). */
  async function pendingOrder(
    env: Env,
    p: Provider,
    lines: Line[] = [{ priceMinor: 1250, stock: 5, qty: 2 }],
  ) {
    const tag = uuidv7().slice(-8)
    const product = await env.product.create({
      slug: `paid-${tag}`,
      name: `Paid ${tag}`,
      status: 'active',
      variants: lines.map((l, i) => ({
        sku: `PAID-${tag}-${i}`,
        name: `V${i}`,
        priceMinor: l.priceMinor,
        stock: l.stock,
        lowStockThreshold: 0,
        options: [],
      })),
    })
    const cart = await env.cart.getOrCreate()
    for (const [i, variant] of product.variants.entries()) {
      await env.cart.addItem(cart.token, {
        variantId: variant.id,
        productId: product.id,
        productName: product.name,
        variantName: variant.name,
        priceMinor: variant.priceMinor,
        imageUrl: '',
        qty: lines[i]!.qty,
      })
    }
    const started = await p.checkout.beginCheckout({
      cartToken: cart.token,
      email: `${tag}+stub-pending@example.com`,
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
    })
    const paid = { amountMinor: started.totalMinor, currency: started.currency }
    return { started, variants: product.variants, paid, intent: started.paymentIntent.id }
  }

  const read = <T>(
    env: Env,
    fn: (tx: Parameters<Parameters<Env['commandStore']['read']>[0]>[0]) => Promise<T>,
  ) => env.commandStore.read(fn)
  const orderOf = async (env: Env, id: string) =>
    (await read(env, (tx) => env.repos.order.findById(tx, id)))!
  const historyOf = (env: Env, id: string) =>
    read(env, (tx) => env.repos.orderHistory.listByOrder(tx, id))
  const rowsOf = (env: Env, id: string) =>
    read(env, (tx) => env.repos.orderRefund.listByOrder(tx, id))
  const stockOf = async (env: Env, variantId: string) =>
    (await read(env, (tx) => env.repos.variant.findById(tx, variantId)))!.stock
  async function events(env: Env, type: string, orderId: string) {
    const all = await read(env, (tx) => env.repos.eventLog.listAll(tx))
    return all
      .map((l) => l.event)
      .filter((e) => e.type === type)
      .map((e) => e.payload as Record<string, unknown>)
      .filter((p) => p.orderId === orderId)
  }
  const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e)

  // Defect (diff review B1): the intent is left open, or cancelled after the payment is recorded; (B4) mark-paid
  // confirms without committing the reservations, records no manual capture, or names a provider payment in its events.
  it('AC-2: mark-paid closes the intent first, then confirms through confirm as a manual capture of the total', async () => {
    const env = await setup()
    const p = withProvider(env)
    const line = { priceMinor: 1250, stock: 5, qty: 2 }
    const { started, variants, intent } = await pendingOrder(env, p, [line])
    let pendingWhenCancelled: string | undefined
    p.script.cancel = async (id) => {
      pendingWhenCancelled = (await orderOf(env, started.orderId)).status
      return p.stub.cancelPaymentIntent(id)
    }

    const order = await p.checkout.markPaid(started.orderId, 'admin:1', 'cash at the till')

    expect(p.calls.cancelled).toEqual([intent])
    expect(pendingWhenCancelled).toBe('pending')
    expect(await p.stub.getPaymentStatus(intent)).toBe('cancelled')
    expect(order.status).toBe('confirmed')
    expect(order.capturedMinor).toBe(order.totalMinor)
    expect(order.captureMethod).toBe('manual')
    expect(order.capturedAt).not.toBeNull()
    expect(order.refundedMinor).toBe(0)
    const last = (await historyOf(env, started.orderId)).at(-1)!
    expect(last).toMatchObject({
      fromStatus: 'pending',
      toStatus: 'confirmed',
      actor: 'admin:1',
      note: 'payment recorded manually: cash at the till',
    })
    // The reservation is committed: the units stay taken, and no reservation is left for the sweeper to release.
    expect(await stockOf(env, variants[0]!.id)).toBe(line.stock - line.qty)
    expect(
      await read(env, (tx) => env.repos.inventoryReservation.findByVariant(tx, variants[0]!.id)),
    ).toHaveLength(0)
    expect(await events(env, EVT_PAYMENT_CAPTURED, started.orderId)).toEqual([
      { paymentId: '', orderId: started.orderId, amountMinor: order.totalMinor, currency: 'GBP' },
    ])
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toEqual([
      {
        orderId: started.orderId,
        paymentIntentId: '',
        amountMinor: order.totalMinor,
        currency: 'GBP',
      },
    ])

    // Without a note the history says only that, and an order with no intent asks the provider nothing.
    const draftId = uuidv7()
    await env.order.createFromCheckout({
      orderId: draftId,
      customerId: null,
      email: 'draft@example.com',
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
      lineItems: [],
      subtotalMinor: 800,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 800,
      currency: 'GBP',
    })
    const draft = await p.checkout.markPaid(draftId, 'admin:2')
    expect(draft.capturedMinor).toBe(draft.totalMinor)
    expect((await historyOf(env, draftId)).at(-1)!.note).toBe('payment recorded manually')
    expect(p.calls.cancelled).toEqual([intent])
    await env.commandStore.close()
  })

  // Defect (diff review B1): a refused cancel is ignored and the order is confirmed while the shopper's payment goes
  // through (charged twice), or any other provider error is swallowed or dressed as payment_in_progress.
  it('diff B1: a cancel the provider refuses answers order.payment_in_progress and changes nothing; any other error is rethrown', async () => {
    const env = await setup()
    const p = withProvider(env)
    const { started, intent } = await pendingOrder(env, p)
    await p.stub.capturePayment(intent)
    const historyBefore = await historyOf(env, started.orderId)

    const err = await refusal(p.checkout.markPaid(started.orderId, 'admin:1'))
    expect(err).toBeInstanceOf(OrderConflictError)
    expect(err).toMatchObject({
      code: 'order.payment_in_progress',
      context: { orderNumber: started.orderNumber },
    })
    expect((err as Error).cause).toBeInstanceOf(PaymentError)

    const fault = new PaymentError('intent_failed', 'provider down')
    p.script.cancel = async () => {
      throw fault
    }
    expect(await refusal(p.checkout.markPaid(started.orderId, 'admin:1'))).toBe(fault)

    const after = await orderOf(env, started.orderId)
    expect(after.status).toBe('pending')
    expect(after.capturedMinor).toBe(0)
    expect(await historyOf(env, started.orderId)).toEqual(historyBefore)
    expect(await events(env, EVT_ORDER_PAID, started.orderId)).toHaveLength(0)
    await env.commandStore.close()
  })

  // Defect: mark-paid of a missing or non-pending order reaches the provider, or confirms an order that a concurrent
  // writer moved while the intent was being cancelled.
  it('AC-2: mark-paid of an unknown or non-pending order, or one moved during the cancel, refuses and records nothing', async () => {
    const env = await setup()
    const p = withProvider(env)
    expect(await refusal(p.checkout.markPaid(uuidv7(), 'admin:1'))).toBeInstanceOf(NotFoundError)

    const first = await pendingOrder(env, p)
    await p.checkout.markPaid(first.started.orderId, 'admin:1')
    const again = await refusal(p.checkout.markPaid(first.started.orderId, 'admin:1'))
    expect(again).toBeInstanceOf(StatusTransitionError)
    expect(again).toMatchObject({ context: { fromStatus: 'confirmed', toStatus: 'confirmed' } })
    expect(p.calls.cancelled).toEqual([first.intent])

    const raced = await pendingOrder(env, p)
    p.script.cancel = async (id) => {
      await env.checkout.cancel(raced.started.orderId, 'shopper gave up')
      return p.stub.cancelPaymentIntent(id)
    }
    const moved = await refusal(p.checkout.markPaid(raced.started.orderId, 'admin:1'))
    expect(moved).toBeInstanceOf(StatusTransitionError)
    expect(moved).toMatchObject({ context: { fromStatus: 'cancelled' } })
    const after = await orderOf(env, raced.started.orderId)
    expect(after.status).toBe('cancelled')
    expect(after.capturedMinor).toBe(0)
    await env.commandStore.close()
  })

  // Defect (B4): a released line whose stock is gone confirms anyway (an oversell), or the refusal is not a 409 naming
  // the variant; or any other fault in confirm is dressed as stock_unavailable.
  it('AC-2: mark-paid whose released stock is gone answers order.stock_unavailable naming the variant, and the order stays pending', async () => {
    const env = await setup()
    const p = withProvider(env)
    const line = { priceMinor: 700, stock: 3, qty: 3 }
    const { started, variants } = await pendingOrder(env, p, [line])
    const v = variants[0]!
    const [held] = await read(env, (tx) => env.repos.inventoryReservation.findByVariant(tx, v.id))
    await env.inventory.releaseReservation(held!.reservationId, 'expired')
    await env.inventory.reserveStock(v.id, line.stock, 'another-order')

    const err = await refusal(p.checkout.markPaid(started.orderId, 'admin:1'))
    expect(err).toBeInstanceOf(OrderConflictError)
    expect(err).toMatchObject({ code: 'order.stock_unavailable', context: { variantId: v.id } })
    const after = await orderOf(env, started.orderId)
    expect(after.status).toBe('pending')
    expect(after.capturedMinor).toBe(0)
    expect(await stockOf(env, v.id)).toBe(0)

    const fault = new Error('database is locked')
    const broken = withProvider(env, {
      ...env.inventory,
      async commitReservation() {
        throw fault
      },
    })
    const other = await pendingOrder(env, broken)
    expect(await refusal(broken.checkout.markPaid(other.started.orderId, 'admin:1'))).toBe(fault)
    expect((await orderOf(env, other.started.orderId)).status).toBe('pending')
    await env.commandStore.close()
  })

  // Defect (diff review B1 backstop): a provider capture of an order the merchant already holds money for is taken as
  // done (kept twice), refunded more than once per intent, refunded in the capture's lower-case currency, or recorded
  // in the order's captured and refunded amounts.
  it('diff B1: a provider capture of a manual or import order is refunded once per intent and recorded as duplicate_capture_refunded', async () => {
    const env = await setup()
    const p = withProvider(env)
    const manual = await pendingOrder(env, p)
    await p.checkout.markPaid(manual.started.orderId, 'admin:1')
    const before = await orderOf(env, manual.started.orderId)
    const paid = { amountMinor: manual.paid.amountMinor, currency: 'gbp' }

    const first = await p.checkout.finalize(manual.intent, paid)
    const second = await p.checkout.finalize(manual.intent, paid)

    expect(first).toEqual({
      orderNumber: manual.started.orderNumber,
      finalized: false,
      reason: 'duplicate_capture_refunded',
    })
    expect(second).toEqual(first)
    expect(p.calls.refunds).toHaveLength(1)
    expect(p.calls.refunds[0]).toMatchObject({
      paymentId: manual.intent,
      amountMinor: paid.amountMinor,
      reason: 'requested_by_customer',
      opts: { currency: 'GBP' },
    })
    const after = await orderOf(env, manual.started.orderId)
    expect([after.capturedMinor, after.refundedMinor, after.captureMethod, after.status]).toEqual([
      before.capturedMinor,
      before.refundedMinor,
      'manual',
      'confirmed',
    ])
    expect(await rowsOf(env, manual.started.orderId)).toHaveLength(0)
    expect(await events(env, EVT_PAYMENT_FAILED, manual.started.orderId)).toEqual([
      { paymentId: manual.intent, orderId: manual.started.orderId, reason: first.reason },
    ])
    expect((await historyOf(env, manual.started.orderId)).at(-1)!.note).toMatch(
      /^captured payment not applied: duplicate_capture_refunded \(capture of .*\d.*\)$/,
    )

    // An imported order is held the same way; a provider-confirmed order is not refunded at all.
    const imported = await env.order.importOrder({
      orderId: uuidv7(),
      orderNumber: `WC-${uuidv7().slice(-10)}`,
      status: 'confirmed',
      customerId: null,
      email: 'wc@example.com',
      billingAddress: makeAddr(),
      shippingAddress: makeAddr(),
      lineItems: [],
      subtotalMinor: 4400,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 4400,
      currency: 'GBP',
      paymentIntentId: 'pi_stub_imported',
      capturedMinor: 4400,
      captureMethod: 'import',
      createdAt: new Date(),
    })
    const fromImport = await p.checkout.finalize('pi_stub_imported', {
      amountMinor: 4400,
      currency: 'GBP',
    })
    expect(fromImport.reason).toBe('duplicate_capture_refunded')
    const provider = await pendingOrder(env, p)
    await p.checkout.finalize(provider.intent, provider.paid)
    expect(await p.checkout.finalize(provider.intent, provider.paid)).toEqual({
      orderNumber: provider.started.orderNumber,
      finalized: true,
    })
    expect(p.calls.refunds.map((c) => c.paymentId)).toEqual([manual.intent, 'pi_stub_imported'])
    const keys = p.calls.refunds.map((c) => c.opts?.idempotencyKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect((await orderOf(env, imported.id)).capturedMinor).toBe(imported.capturedMinor)
    await env.commandStore.close()
  })

  // Defect: an unknown refund outcome is recorded as done (the redelivery never asks again, money may be kept twice)
  // or retried under a new key (refunded twice); a refusal or a mismatched answer is retried for ever or recorded as
  // refunded.
  it('diff B1: the backstop throws on an unknown outcome and the redelivery asks again under the same key; failed and pending are recorded once', async () => {
    const env = await setup()
    const p = withProvider(env)
    const held = async () => {
      const o = await pendingOrder(env, p)
      await p.checkout.markPaid(o.started.orderId, 'admin:1')
      return o
    }

    const unknown = await held()
    p.script.refund = failing(new PaymentError('refund_unknown', 'timeout'))
    const err = await refusal(p.checkout.finalize(unknown.intent, unknown.paid))
    expect(err).toBeInstanceOf(CheckoutError)
    expect(err).toMatchObject({
      code: 'checkout.finalize_failed',
      context: { orderNumber: unknown.started.orderNumber },
    })
    expect(await events(env, EVT_PAYMENT_FAILED, unknown.started.orderId)).toHaveLength(0)
    p.script.refund = echo
    const retried = await p.checkout.finalize(unknown.intent, unknown.paid)
    expect(retried.reason).toBe('duplicate_capture_refunded')
    const [asked, again] = p.calls.refunds
    expect(again!.opts?.idempotencyKey).toBe(asked!.opts?.idempotencyKey)

    const outcomes: Array<[string, (c: RefundCall) => Promise<Refund>, string]> = [
      [
        'rejected',
        failing(new PaymentError('refund_rejected', 'no')),
        'duplicate_capture_refund_failed',
      ],
      [
        'another amount',
        async (c) => ({ ...(await echo(c)), amountMinor: (c.amountMinor ?? 0) - 1 }),
        'duplicate_capture_refund_pending',
      ],
    ]
    for (const [, answer, reason] of outcomes) {
      const o = await held()
      p.script.refund = answer
      const callsBefore = p.calls.refunds.length
      expect((await p.checkout.finalize(o.intent, o.paid)).reason).toBe(reason)
      expect((await p.checkout.finalize(o.intent, o.paid)).reason).toBe(
        'duplicate_capture_refunded',
      )
      expect(p.calls.refunds.length).toBe(callsBefore + 1)
      expect(await events(env, EVT_PAYMENT_FAILED, o.started.orderId)).toEqual([
        { paymentId: o.intent, orderId: o.started.orderId, reason },
      ])
    }
    await env.commandStore.close()
  })

  // Defect (diff review M3, decision 4 "a cancelled order nets to zero"): the capture or its refund row is not written,
  // the key is not the row's id (or is the same for every intent), a second delivery refunds again, or the refund is
  // published without succeeding.
  it('AC-13: a capture for a cancelled order is recorded with a refund row keyed by its id, refunded once, and nets to zero', async () => {
    const env = await setup()
    const p = withProvider(env)
    const orders = [await pendingOrder(env, p), await pendingOrder(env, p)]
    for (const o of orders) await p.checkout.cancel(o.started.orderId, 'shopper gave up')

    for (const o of orders) {
      const result = await p.checkout.finalize(o.intent, o.paid)
      expect(result.reason).toBe('order_cancelled_refunded')
      await p.checkout.finalize(o.intent, o.paid)
    }

    expect(p.calls.refunds).toHaveLength(orders.length)
    const keys = p.calls.refunds.map((c) => c.opts?.idempotencyKey)
    expect(new Set(keys).size).toBe(orders.length)
    for (const [i, o] of orders.entries()) {
      const after = await orderOf(env, o.started.orderId)
      const rows = await rowsOf(env, o.started.orderId)
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(p.calls.refunds[i]).toMatchObject({
        paymentId: o.intent,
        amountMinor: o.paid.amountMinor,
        opts: { idempotencyKey: row!.id, currency: 'GBP' },
      })
      expect(row).toMatchObject({
        amountMinor: o.paid.amountMinor,
        currency: 'GBP',
        status: 'succeeded',
        actor: 'system:checkout',
        reason: 'captured for a cancelled order',
      })
      expect(row!.providerRefundId).toMatch(/^re_/)
      expect(after.status).toBe('cancelled')
      expect(after.captureMethod).toBe('provider')
      expect(after.capturedMinor).toBe(o.paid.amountMinor)
      expect(after.refundedMinor).toBe(after.capturedMinor)
      expect(await events(env, EVT_PAYMENT_REFUNDED, o.started.orderId)).toEqual([
        {
          paymentId: o.intent,
          orderId: o.started.orderId,
          refundId: row!.id,
          amountMinor: o.paid.amountMinor,
          currency: 'GBP',
        },
      ])
      expect((await historyOf(env, o.started.orderId)).at(-1)!.note).toBe(
        'captured payment not applied: order_cancelled_refunded',
      )
    }
    await env.commandStore.close()
  })

  // Defect: refundCapture settles an unknown outcome (a timeout, any other fault) as failed, so the shop believes no
  // money moved; or a refusal or mismatched answer is counted as refunded.
  it("AC-13: the cancelled capture's row is failed only on refund_rejected, and stays pending on any unknown outcome or mismatch", async () => {
    const env = await setup()
    const p = withProvider(env)
    const cases: Array<[(c: RefundCall) => Promise<Refund>, string, string | null]> = [
      [failing(new PaymentError('refund_rejected', 'no')), 'failed', null],
      [failing(new PaymentError('refund_unknown', 'timeout')), 'pending', null],
      [failing(new PaymentError('capture_failed', 'odd')), 'pending', null],
      [
        failing(Object.assign(new Error('reset'), { code: 'payment.refund_rejected' })),
        'pending',
        null,
      ],
      [async (c) => ({ ...(await echo(c)), refundId: 're_x', currency: 'EUR' }), 'pending', null],
      [async (c) => ({ ...(await echo(c)), refundId: 're_y', status: 'pending' }), 'pending', null],
    ]
    for (const [answer, status, providerRefundId] of cases) {
      const o = await pendingOrder(env, p)
      await p.checkout.cancel(o.started.orderId, 'gave up')
      p.script.refund = answer
      const result = await p.checkout.finalize(o.intent, o.paid)
      expect(result.reason).toBe('order_cancelled_refunded')
      const [row] = await rowsOf(env, o.started.orderId)
      expect(row!.status).toBe(status)
      // A row left pending is not settled, so it holds no provider id until it is reconciled.
      expect(row!.providerRefundId).toBe(providerRefundId)
      const after = await orderOf(env, o.started.orderId)
      expect(after.capturedMinor).toBe(o.paid.amountMinor)
      expect(after.refundedMinor).toBe(0)
      expect(await events(env, EVT_PAYMENT_REFUNDED, o.started.orderId)).toHaveLength(0)
    }
    await env.commandStore.close()
  })

  // Defect: settled treats every non-pending, non-confirmed order as cancelled (refunding a shipped order's capture)
  // or loses the status from the recorded reason.
  it('decision 4 check order: a delivery for a processing order records order_not_pending with its status and refunds nothing', async () => {
    const env = await setup()
    const p = withProvider(env)
    const o = await pendingOrder(env, p)
    await p.checkout.finalize(o.intent, o.paid)
    await env.order.updateStatus(o.started.orderId, 'processing', 'admin:1')

    const result = await p.checkout.finalize(o.intent, o.paid)
    expect(result).toEqual({
      orderNumber: o.started.orderNumber,
      finalized: false,
      reason: 'order_not_pending: processing',
    })
    expect(p.calls.refunds).toHaveLength(0)
    expect(await rowsOf(env, o.started.orderId)).toHaveLength(0)
    expect((await historyOf(env, o.started.orderId)).at(-1)!.note).toBe(
      'captured payment not applied: order_not_pending: processing',
    )
    await env.commandStore.close()
  })
})
