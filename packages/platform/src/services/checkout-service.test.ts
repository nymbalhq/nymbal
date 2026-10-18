import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  EVT_ORDER_PAID,
  EVT_ORDER_PLACED,
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_FAILED,
  EVT_CART_CONVERTED,
  EVT_CART_UPDATED,
  CheckoutError,
  NotFoundError,
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
      email: 'cancel@example.com',
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
  it('decision 4 check order: status is decided before amount, so a non-pending order never reports amount_mismatch', async () => {
    const env = await setup()
    const cancelled = await placeOrder(env, [{ priceMinor: 820, stock: 3, qty: 1 }])
    await env.checkout.cancel(cancelled.started.orderId, 'admin cancelled')
    const confirmed = await placeOrder(env, [{ priceMinor: 540, stock: 3, qty: 1 }])
    await env.checkout.finalize(confirmed.started.paymentIntent.id, confirmed.paid)

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom('GBP', 'usd'),
        async (amountMinor, currency) => {
          const wrongOrRight = { amountMinor, currency }
          expect(
            await env.checkout.finalize(cancelled.started.paymentIntent.id, wrongOrRight),
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
  })

  // Defect: the status check is skipped, so a captured payment confirms a cancelled order and takes its stock.
  // P1-12 AC-12 (decision 11): the capture is refunded and recorded as order_cancelled_refunded.
  it('AC-6b: a captured payment for a cancelled order is order_cancelled_refunded, recorded, the order untouched', async () => {
    const env = await setup()
    const { started, variants, paid } = await placeOrder(env, [
      { priceMinor: 700, stock: 4, qty: 1 },
    ])
    await env.checkout.cancel(started.orderId, 'admin cancelled')
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
