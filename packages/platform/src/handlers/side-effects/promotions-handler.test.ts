import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import {
  EVT_ORDER_CANCELLED,
  EVT_ORDER_PAID,
  type EventBusAdapter,
  type NymbalEvent,
  type OrderCancelledV1Payload,
  type OrderPaidV1Payload,
  type PromotionOrder,
  type PromotionsAdapter,
} from '@nymbalhq/types'
import { createNativePromotionsAdapter } from '../../adapters/promotions/native-adapter.js'
import { createNotConfiguredAdapter } from '../../adapters/not-configured.js'
import { createCommandStore, type CommandStore } from '../../db/command-store.js'
import { runMigrations } from '../../db/migrate.js'
import { InMemoryDocumentStore } from '../../document-store/in-memory.js'
import { InProcessEventBus } from '../../event-bus/in-process.js'
import { createEventBuilder } from '../../events/builder.js'
import { createLogger } from '../../logger.js'
import { buildRepositories, type Repositories } from '../../repositories/index.js'
import { TEST_BUILDER_CONTEXT } from '../../tests/publisher.js'
import { registerPromotionsHandler } from './promotions-handler.js'

// The kernel tells the promotions engine a paid order is closed and a cancelled order cancelled, on a SQLite `:memory:`
// store and the in-process bus: once per event however often it is delivered, only for an order the engine itself
// placed, again on the next delivery when the engine failed, and never for an engine without the method or for the
// placeholder of an unconfigured slot.

const logger = createLogger({ pretty: false, level: 'silent' })
const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

let store: CommandStore
let repos: Repositories

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error a minimal config: only the command store kind is read
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'promotions', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../../migrations', import.meta.url).pathname,
  })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
})

afterAll(async () => {
  await store?.close()
})

interface Engine {
  adapter: PromotionsAdapter
  closes: { sessionId: string; order: PromotionOrder }[]
  cancels: { sessionId: string; orderId: string }[]
  /** Every close and cancel rejects until `recover()`. */
  fail(): void
  recover(): void
}

/** An engine that keeps what it was told; it fails on demand, as an unreachable Talon.One would. */
function engine(providerName = 'talon-one'): Engine {
  const closes: Engine['closes'] = []
  const cancels: Engine['cancels'] = []
  let down = false
  const adapter = {
    kind: 'promotions',
    providerName,
    capabilities: () => ['codes', 'automatic', 'line'],
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' as const }),
    evaluate: async () => ({ effects: [] }),
    async close(sessionId: string, order: PromotionOrder) {
      if (down) throw new Error('the promotions engine is unreachable')
      closes.push({ sessionId, order })
    },
    async cancel(sessionId: string, orderId: string) {
      if (down) throw new Error('the promotions engine is unreachable')
      cancels.push({ sessionId, orderId })
    },
  } as unknown as PromotionsAdapter
  return {
    adapter,
    closes,
    cancels,
    fail: () => {
      down = true
    },
    recover: () => {
      down = false
    },
  }
}

interface Rig {
  bus: EventBusAdapter
  /** Every pattern subscribed to through the bus, flattened. */
  subscribed: string[]
}

/** A fresh bus with the handler registered for `promotions`, recording what it subscribes to. */
async function rig(promotions: PromotionsAdapter): Promise<Rig> {
  const underneath = new InProcessEventBus({ logger })
  const subscribed: string[] = []
  const bus: EventBusAdapter = {
    capabilities: () => underneath.capabilities(),
    publish: (event) => underneath.publish(event),
    publishBatch: (events) => underneath.publishBatch(events),
    replay: (events) => underneath.replay(events),
    subscribe: (pattern, handler, config) => {
      subscribed.push(...(Array.isArray(pattern) ? pattern : [pattern]))
      return underneath.subscribe(pattern, handler, config)
    },
    unsubscribe: (subscription) => underneath.unsubscribe(subscription),
    close: () => underneath.close(),
  }
  await registerPromotionsHandler({
    eventBus: bus,
    promotions,
    processedEventRepo: repos.processedEvent,
    repos: { order: repos.order },
    logger,
  })
  return { bus, subscribed }
}

let sequence = 0

/** A pending order with the given promotion record in its metadata (none when undefined). */
async function insertOrder(record: Record<string, unknown> | undefined) {
  sequence += 1
  const id = uuidv7()
  const now = new Date()
  await store.transaction((tx) =>
    repos.order.insert(tx, {
      id,
      orderNumber: `PROMO-${sequence}-${id.slice(-6)}`,
      sequence: 10_000 + sequence,
      customerId: null,
      status: 'pending',
      email: `buyer-${sequence}@promotions.test`,
      billingAddress: {} as never,
      shippingAddress: {} as never,
      lineItems: [],
      subtotalMinor: 4000 + sequence,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 400 + sequence,
      totalMinor: 3600,
      currency: 'GBP',
      notes: '',
      metadata: record === undefined ? {} : { promotions: record },
      paymentIntentId: null,
      cartToken: `cart-${id}`,
      createdAt: now,
      updatedAt: now,
    }),
  )
  return (await store.read((tx) => repos.order.findById(tx, id)))!
}

/** What the engine must be told of a stored order: its id, number, currency and money columns. */
const promotionOrderOf = (order: {
  id: string
  orderNumber: string
  currency: string
  subtotalMinor: number
  discountTotalMinor: number
  totalMinor: number
}): PromotionOrder => ({
  orderId: order.id,
  orderNumber: order.orderNumber,
  currency: order.currency,
  subtotalMinor: order.subtotalMinor,
  discountTotalMinor: order.discountTotalMinor,
  totalMinor: order.totalMinor,
})

const recordFor = (provider: string, sessionId = `cart-session-${uuidv7()}`) => ({
  provider,
  sessionId,
  codes: ['SAVE10'],
  effects: [{ kind: 'order', amountMinor: 400, label: 'SAVE10', code: 'SAVE10' }],
})

const paid = (orderId: string): NymbalEvent<OrderPaidV1Payload> =>
  makeEvent(EVT_ORDER_PAID, {
    orderId,
    paymentIntentId: `pi_${orderId}`,
    amountMinor: 3600,
    currency: 'GBP',
  })

const cancelled = (orderId: string): NymbalEvent<OrderCancelledV1Payload> =>
  makeEvent(EVT_ORDER_CANCELLED, { orderId, reason: 'abandoned' })

const processed = (handlerName: string, eventId: string) =>
  store.read((tx) => repos.processedEvent.seen(tx, handlerName, eventId))

describe('AC-10: a paid order is closed and a cancelled order cancelled, once, at the engine that placed it', () => {
  it('AC-10: order.paid for an order the engine placed calls close once with the record’s session id and the order’s id, number, currency, subtotal, discount and total', async () => {
    const e = engine()
    const { bus } = await rig(e.adapter)
    const record = recordFor(e.adapter.providerName)
    const order = await insertOrder(record)
    const event = paid(order.id)

    await bus.publish(event)

    expect(e.closes.map((c) => c.sessionId)).toEqual([record.sessionId])
    expect(e.closes.map((c) => c.order)).toEqual([promotionOrderOf(order)])
    expect(e.cancels).toEqual([])
    expect(await processed('promotions.close', event.id)).toBe(true)
  })

  it('AC-10: the same order.paid delivered again calls nothing more', async () => {
    const e = engine()
    const { bus } = await rig(e.adapter)
    const order = await insertOrder(recordFor(e.adapter.providerName))
    const event = paid(order.id)
    await bus.publish(event)
    const after = e.closes.length

    await bus.publish(event)
    await bus.publish(event)

    expect(e.closes.length).toBe(after)
    expect(after).toBe(1)
  })

  it('AC-10: order.paid for an order with no promotion record, or a record naming another provider, calls nothing', async () => {
    const e = engine()
    const { bus } = await rig(e.adapter)
    const bare = await insertOrder(undefined)
    const native = await insertOrder(recordFor('native'))

    await bus.publish(paid(bare.id))
    await bus.publish(paid(native.id))

    expect(e.closes).toEqual([])
  })

  it('AC-10: order.cancelled for an order the engine placed calls cancel once with the record’s session id and the order’s id; again, nothing more', async () => {
    const e = engine()
    const { bus } = await rig(e.adapter)
    const record = recordFor(e.adapter.providerName)
    const order = await insertOrder(record)
    const event = cancelled(order.id)

    await bus.publish(event)
    await bus.publish(event)

    expect(e.cancels).toEqual([{ sessionId: record.sessionId, orderId: order.id }])
    expect(e.closes).toEqual([])
    expect(await processed('promotions.cancel', event.id)).toBe(true)
  })

  it('AC-10: order.cancelled for an order with no promotion record, or a record naming another provider, calls nothing', async () => {
    const e = engine()
    const { bus } = await rig(e.adapter)
    const bare = await insertOrder(undefined)
    const native = await insertOrder(recordFor('native'))

    await bus.publish(cancelled(bare.id))
    await bus.publish(cancelled(native.id))

    expect(e.cancels).toEqual([])
  })
})

describe('AC-11: a failed close or cancel is tried again; an engine without them is never subscribed', () => {
  const retried: [string, string, (orderId: string) => NymbalEvent<unknown>, (e: Engine) => number][] = [
    ['close', 'promotions.close', paid, (e) => e.closes.length],
    ['cancel', 'promotions.cancel', cancelled, (e) => e.cancels.length],
  ]
  for (const [name, handlerName, deliver, told] of retried) {
    it(`AC-11: a ${name} that rejects rejects the delivery and writes no processed row; the next delivery that succeeds writes one`, async () => {
      const e = engine()
      const { bus } = await rig(e.adapter)
      const order = await insertOrder(recordFor(e.adapter.providerName))
      const event = deliver(order.id)
      e.fail()

      const first = await bus.publish(event).then(
        () => 'resolved',
        () => 'rejected',
      )
      const afterFailure = await processed(handlerName, event.id)
      e.recover()
      await bus.publish(event)

      expect(first).toBe('rejected')
      expect(afterFailure).toBe(false)
      expect(await processed(handlerName, event.id)).toBe(true)
      expect(told(e)).toBe(1)
    })
  }

  it('AC-11: with the native engine no order.paid or order.cancelled subscription exists, and paying or cancelling an order writes no row under promotions.close or promotions.cancel', async () => {
    const native = createNativePromotionsAdapter({ repos, logger })
    const { bus, subscribed } = await rig(native)
    const order = await insertOrder(recordFor(native.providerName))
    const pay = paid(order.id)
    const cancel = cancelled(order.id)

    await bus.publish(pay)
    await bus.publish(cancel)

    expect(subscribed.filter((p) => /order\.(paid|cancelled)/.test(p))).toEqual([])
    expect([
      await processed('promotions.close', pay.id),
      await processed('promotions.cancel', cancel.id),
    ]).toEqual([false, false])
  })

  it('AC-11: with the not-configured placeholder no subscription exists, and paying an order resolves with no row under promotions.close', async () => {
    const placeholder = createNotConfiguredAdapter('promotions', 'talon-one', [
      'apiKey',
    ]) as PromotionsAdapter
    const { bus, subscribed } = await rig(placeholder)
    const order = await insertOrder(recordFor('talon-one'))
    const pay = paid(order.id)
    const cancel = cancelled(order.id)

    const outcome = await Promise.all([bus.publish(pay), bus.publish(cancel)]).then(
      () => 'resolved',
      (err: unknown) => `rejected: ${String(err)}`,
    )

    expect(subscribed.filter((p) => /order\.(paid|cancelled)/.test(p))).toEqual([])
    expect(outcome).toBe('resolved')
    expect([
      await processed('promotions.close', pay.id),
      await processed('promotions.cancel', cancel.id),
    ]).toEqual([false, false])
  })
})
