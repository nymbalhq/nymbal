import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  EVT_ORDER_PLACED,
  EVT_ORDER_SHIPPED,
  EVT_ORDER_DELIVERED,
  EVT_ORDER_CANCELLED,
  NotFoundError,
  OrderConflictError,
  StatusTransitionError,
  ValidationError,
  type CaptureMethod,
  type OrderStatus,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createOrderService } from './order-service.js'
import { createProductService } from './product-service.js'
import { createLogger } from '../logger.js'
import { v7 as uuidv7 } from 'uuid'
import type { Address, OrderLineItem } from '@nymbalhq/types'

const addr: Address = {
  firstName: 'Jane',
  lastName: 'Doe',
  addressLine1: '1 Test St',
  city: 'London',
  region: 'England',
  postalCode: 'SW1A 1AA',
  country: 'GB',
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
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
  const product = createProductService({ store: commandStore, repos, publisher, logger })
  const orderService = createOrderService({
    store: commandStore,
    repos,
    publisher,
    logger,
    orderNumberPrefix: 'TEST',
    orderNumberStart: 1000,
  })
  return { commandStore, eventBus, orderService, product, repos }
}

async function createLine(price = 2500, qty = 1): Promise<OrderLineItem> {
  return {
    variantId: uuidv7(),
    productId: uuidv7(),
    productName: 'Test',
    variantName: 'Default',
    sku: 'SKU-1',
    qty,
    unitPriceMinor: price,
    lineSubtotalMinor: price * qty,
    lineTaxMinor: 0,
    lineTotalMinor: price * qty,
    imageUrl: '',
  }
}

describe('OrderService', () => {
  it('createFromCheckout emits order.placed + returns order with orderNumber', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_PLACED, (e) => {
      received.push(e.payload)
    })
    const line = await createLine()
    const order = await orderService.createFromCheckout({
      orderId: uuidv7(),
      customerId: null,
      email: 'test@example.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
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
      orderId: id,
      customerId: null,
      email: 'a@b.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
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
      orderId: id,
      customerId: null,
      email: 'b@c.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
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
      orderId: uuidv7(),
      customerId,
      email: 'c@d.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
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
      orderId: id,
      customerId: null,
      email: 'd@e.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
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
      orderId: id,
      customerId: null,
      email: 'e@f.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
    })
    await expect(orderService.updateStatus(id, 'delivered', 'admin')).rejects.toThrow()
    await commandStore.close()
  })

  it('markShipped emits shipped event', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const id = uuidv7()
    const line = await createLine()
    await orderService.createFromCheckout({
      orderId: id,
      customerId: null,
      email: 'f@g.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
    })
    await orderService.updateStatus(id, 'confirmed', 'admin')
    await orderService.updateStatus(id, 'processing', 'admin')
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_SHIPPED, (e) => {
      received.push(e.payload)
    })
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
      orderId: id,
      customerId: null,
      email: 'g@h.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
    })
    await orderService.updateStatus(id, 'confirmed', 'admin')
    await orderService.updateStatus(id, 'processing', 'admin')
    await orderService.markShipped(id, 'TRK999', 'DHL', 'admin')
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_DELIVERED, (e) => {
      received.push(e.payload)
    })
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
      orderId: id,
      customerId: null,
      email: 'h@i.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
    })
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_CANCELLED, (e) => {
      received.push(e.payload)
    })
    const cancelled = await orderService.cancel(id, 'test reason', 'admin')
    expect(cancelled.status).toBe('cancelled')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('importOrder inserts historical order and emits order.placed', async () => {
    const { commandStore, eventBus, orderService } = await setup()
    const received: unknown[] = []
    await eventBus.subscribe(EVT_ORDER_PLACED, (e) => {
      received.push(e.payload)
    })
    const line = await createLine(1500, 3)
    const now = new Date('2024-01-15T10:00:00Z')
    const order = await orderService.importOrder({
      orderId: uuidv7(),
      orderNumber: 'WC-1001',
      status: 'confirmed',
      customerId: null,
      email: 'import@example.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 100,
      shippingTotalMinor: 500,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor + 600,
      currency: 'GBP',
      notes: 'Imported from WooCommerce',
      metadata: { wcOrderId: 1001 },
      paymentIntentId: 'pi_wc_1001',
      createdAt: now,
    })
    expect(order.orderNumber).toBe('WC-1001')
    expect(order.status).toBe('confirmed')
    expect(order.notes).toBe('Imported from WooCommerce')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('importOrder works with minimal optional fields', async () => {
    const { commandStore, orderService } = await setup()
    const line = await createLine()
    const order = await orderService.importOrder({
      orderId: uuidv7(),
      orderNumber: 'WC-1002',
      status: 'confirmed',
      customerId: null,
      email: 'min@example.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: line.lineTotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: line.lineTotalMinor,
      currency: 'GBP',
      createdAt: new Date(),
    })
    expect(order.orderNumber).toBe('WC-1002')
    await commandStore.close()
  })

  // P1-12 decision 6. Defect: createFromCheckout drops the cart token (a resubmit then never finds its pending order and
  // makes a second one), the pending lookup returns a settled order, or the converted lookup returns a pending or
  // cancelled order, or an older one, so an emptied cart's 409 names the wrong order.
  it("decision 6: a cart's pending order is found by its token, and its last converted order excludes pending and cancelled ones", async () => {
    const { commandStore, orderService, repos } = await setup()
    const token = uuidv7()
    const other = uuidv7()
    const place = async (cartToken: string) => {
      const line = await createLine()
      return orderService.createFromCheckout({
        orderId: uuidv7(),
        customerId: null,
        email: 'cart@example.com',
        billingAddress: addr,
        shippingAddress: addr,
        lineItems: [line],
        subtotalMinor: line.lineTotalMinor,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor: line.lineTotalMinor,
        currency: 'GBP',
        cartToken,
      })
    }
    const pendingOf = (t: string) =>
      commandStore.read((tx) => repos.order.findPendingByCartToken(tx, t))
    const convertedOf = (t: string) =>
      commandStore.read((tx) => repos.order.findLastConvertedByCartToken(tx, t))

    const older = await place(token)
    expect((await pendingOf(token))?.id).toBe(older.id)
    await orderService.updateStatus(older.id, 'confirmed', 'admin')
    expect(await pendingOf(token)).toBeNull()
    const converted = await place(token)
    await orderService.updateStatus(converted.id, 'confirmed', 'admin')
    const cancelled = await place(token)
    await orderService.cancel(cancelled.id, 'changed my mind', 'admin')
    const pending = await place(token)
    const elsewhere = await place(other)

    expect((await pendingOf(token))?.id).toBe(pending.id)
    expect((await pendingOf(other))?.id).toBe(elsewhere.id)
    expect(await pendingOf(uuidv7())).toBeNull()
    // The newest order the cart became, past a later cancelled one and the pending one.
    expect((await convertedOf(token))?.id).toBe(converted.id)
    expect(converted.sequence).toBeGreaterThan(older.sequence)
    expect(await convertedOf(other)).toBeNull()
    await commandStore.close()
  })
})

// P1-13 (spec P1-13-admin-truth-about-money): decision 4's "a captured order cannot be cancelled" with the diff
// review's B2 (the paid check and the write under the row lock, the write conditional), and decision 2's imported
// capture. The integration suites pin these through the routes; these pin them where Stryker mutates the service.
describe('OrderService: P1-13 cancel of a paid order and imported captures', () => {
  type Env = Awaited<ReturnType<typeof setup>>

  async function importWith(
    env: Env,
    money: {
      totalMinor: number
      capturedMinor?: number
      refundedMinor?: number
      captureMethod?: CaptureMethod | null
    },
    extra: { status?: OrderStatus; notes?: string; paymentIntentId?: string } = {},
  ) {
    const line = await createLine(money.totalMinor, 1)
    return env.orderService.importOrder({
      orderId: uuidv7(),
      orderNumber: `WC-${uuidv7().slice(-12)}`,
      status: extra.status ?? 'confirmed',
      customerId: null,
      email: 'import@example.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [line],
      subtotalMinor: money.totalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: money.totalMinor,
      currency: 'GBP',
      createdAt: new Date('2024-03-01T09:30:00Z'),
      ...(money.capturedMinor !== undefined && { capturedMinor: money.capturedMinor }),
      ...(money.refundedMinor !== undefined && { refundedMinor: money.refundedMinor }),
      ...(money.captureMethod !== undefined && { captureMethod: money.captureMethod }),
      ...(extra.notes !== undefined && { notes: extra.notes }),
      ...(extra.paymentIntentId !== undefined && { paymentIntentId: extra.paymentIntentId }),
    })
  }

  const historyOf = (env: Env, orderId: string) =>
    env.commandStore.read((tx) => env.repos.orderHistory.listByOrder(tx, orderId))
  async function cancelledEvents(env: Env, orderId: string) {
    const all = await env.commandStore.read((tx) => env.repos.eventLog.listAll(tx))
    return all.filter(
      (l) =>
        l.event.type === EVT_ORDER_CANCELLED &&
        (l.event.payload as { orderId?: string }).orderId === orderId,
    )
  }

  // Defect: the paid guard is dropped or tests the wrong amount (`>= 0`, `< 0`), so an admin cancels money away.
  it('AC-6 (B1): cancel of an order with anything captured refuses order.paid and changes nothing; with nothing captured it cancels', async () => {
    const env = await setup()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        async (totalMinor, rawCaptured) => {
          const capturedMinor = rawCaptured % (totalMinor + 1)
          const order = await importWith(env, {
            totalMinor,
            capturedMinor,
            ...(capturedMinor > 0 && { captureMethod: 'manual' as const }),
          })
          const historyBefore = (await historyOf(env, order.id)).length
          const paid = capturedMinor > 0
          const outcome = await env.orderService.cancel(order.id, 'changed mind', 'admin:1').then(
            (o) => o.status,
            (e: unknown) => (e instanceof OrderConflictError ? e.code : e),
          )
          expect(outcome).toBe(paid ? 'order.paid' : 'cancelled')
          expect((await env.orderService.getById(order.id)).status).toBe(
            paid ? order.status : 'cancelled',
          )
          expect((await historyOf(env, order.id)).length).toBe(historyBefore + (paid ? 0 : 1))
          expect((await cancelledEvents(env, order.id)).length).toBe(paid ? 0 : 1)
        },
      ),
      { numRuns: 25 },
    )
    await env.commandStore.close()
  })

  // Defect: the missing order falls through to a TypeError on `order.capturedMinor` instead of a 404.
  it('AC-6: cancel of an unknown order is NotFoundError', async () => {
    const env = await setup()
    await expect(env.orderService.cancel(uuidv7(), 'x', 'admin:1')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    await env.commandStore.close()
  })

  // Defect (B2): the write is unconditional, or a lost conditional write is ignored, so a confirm that commits between
  // the read and the write is overwritten to cancelled; or the refusal names the stale status instead of the current.
  it('AC-6 (B2): a cancel whose conditional write loses to a concurrent confirm refuses with the current status and writes nothing', async () => {
    const env = await setup()
    const order = await importWith(env, { totalMinor: 4200 }, { status: 'pending' })
    const historyBefore = (await historyOf(env, order.id)).length
    // The concurrent writer: the order is confirmed just before the conditional write runs.
    const racing = {
      ...env.repos,
      order: {
        ...env.repos.order,
        async setStatusIf(...args: Parameters<Env['repos']['order']['setStatusIf']>) {
          const [tx, id, , , at] = args
          await env.repos.order.setStatus(tx, id, 'confirmed', at)
          return env.repos.order.setStatusIf(...args)
        },
      },
    }
    const service = createOrderService({
      store: env.commandStore,
      repos: racing,
      publisher: wirePublisher(
        { createEventPublisher, createRelay },
        {
          store: env.commandStore,
          eventLog: env.repos.eventLog,
          eventBus: env.eventBus,
          logger: createLogger({ pretty: false, level: 'error' }),
        },
      ).publisher,
      logger: createLogger({ pretty: false, level: 'error' }),
      orderNumberPrefix: 'TEST',
      orderNumberStart: 1000,
    })
    const err = await service.cancel(order.id, 'too late', 'admin:1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StatusTransitionError)
    expect((err as StatusTransitionError).context).toMatchObject({
      fromStatus: 'confirmed',
      toStatus: 'cancelled',
    })
    // The simulated confirm ran inside the cancel's transaction, so the refusal rolls it back with everything else.
    expect((await env.orderService.getById(order.id)).status).toBe(order.status)
    expect((await historyOf(env, order.id)).length).toBe(historyBefore)
    expect(await cancelledEvents(env, order.id)).toHaveLength(0)
    await env.commandStore.close()
  })

  // Defect: any bound of 0 <= refunded <= captured <= total is dropped or flipped, or a capture is accepted without a
  // method (or a method without a capture), so an import writes amounts the payment state cannot read.
  it('decision 2: importOrder accepts the amounts exactly when 0 <= refunded <= captured <= total and a method names a capture', async () => {
    const env = await setup()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: -2, max: 10_002 }),
        fc.integer({ min: -2, max: 10_002 }),
        fc.constantFrom<CaptureMethod | null>('import', 'manual', 'provider', null),
        async (totalMinor, capturedMinor, refundedMinor, captureMethod) => {
          const valid =
            0 <= refundedMinor &&
            refundedMinor <= capturedMinor &&
            capturedMinor <= totalMinor &&
            capturedMinor > 0 === (captureMethod !== null)
          const result = await importWith(env, {
            totalMinor,
            capturedMinor,
            refundedMinor,
            captureMethod,
          }).then(
            (o) => ({
              capturedMinor: o.capturedMinor,
              refundedMinor: o.refundedMinor,
              captureMethod: o.captureMethod,
            }),
            (e: unknown) => (e instanceof ValidationError ? { refused: e.context } : e),
          )
          expect(result).toEqual(
            valid
              ? { capturedMinor, refundedMinor, captureMethod }
              : { refused: { capturedMinor, refundedMinor, totalMinor } },
          )
        },
      ),
      {
        numRuns: 120,
        examples: [
          [100, 100, 100, 'import'],
          [100, 101, 0, 'import'],
          [100, 50, 51, 'import'],
          [100, 50, -1, 'import'],
          [100, 50, 0, null],
          [100, 0, 0, 'import'],
          [100, 0, 0, null],
        ],
      },
    )
    await env.commandStore.close()
  })

  // Defect: the capture is dropped, stamped now instead of when the order was placed, or the optional fields default
  // to something other than nothing (notes, intent, no capture).
  it("decision 2: an imported capture is recorded at the order's placing, and an import without one records nothing", async () => {
    const env = await setup()
    const paid = await importWith(
      env,
      { totalMinor: 3100, capturedMinor: 3100, refundedMinor: 1100, captureMethod: 'import' },
      { notes: 'from woo', paymentIntentId: 'pi_wc_77' },
    )
    expect(paid.capturedAt).toBe(paid.createdAt)
    expect(paid.refundedMinor).toBe(paid.capturedMinor - 2000)
    expect(paid.notes).toBe('from woo')
    expect(paid.paymentIntentId).toBe('pi_wc_77')

    const bare = await importWith(env, { totalMinor: 900 })
    expect(bare.capturedMinor).toBe(0)
    expect(bare.refundedMinor).toBe(0)
    expect(bare.captureMethod).toBeNull()
    expect(bare.capturedAt).toBeNull()
    expect(bare.notes).toBe('')
    expect(bare.paymentIntentId).toBeNull()
    expect(bare.metadata).toEqual({})
    await env.commandStore.close()
  })
})
