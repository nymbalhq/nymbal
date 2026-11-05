import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { normaliseTrackingNumber, type ShippingAdapter } from '@nymbalhq/types'
import {
  EASYPOST_TEST_WEBHOOK_SECRET,
  signedPost,
  trackerEvent,
} from '../../../../tests/support/easypost.js'
import { createNotConfiguredAdapter } from '../../src/adapters/not-configured.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { customSlots, postDelivery } from '../support/inbound-webhooks.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { captureLogs, stringsIn, type LogCapture } from '../support/settings.js'
import {
  drained,
  orderState,
  processedBy,
  processingOrder,
  shippedEvents,
  shipThroughAdmin,
  START_TRACKING_HANDLER,
} from '../support/shipping-orders.js'
import { createTestShipAdapter, type TestShipAdapter } from '../support/test-ship.js'

// Shipping an order registers its tracking number with the store's shipping provider when, and only when, the adapter
// declares `tracking` and has startTracking: once per order.shipped.v1, however often the relay hands the event on;
// retried by the relay while the provider fails, held through an outage rather than dying; a refusal logged once with
// the number redacted and never retried. Registering never moves the order, and the ship route answers 200 whatever
// the provider does. Through the served kernel's admin route, the provider being the test shipping adapter (custom).

/** A tracking number as a merchant may type it: grouped by spaces, lower case. */
function typed(n: string): string {
  return (n.match(/.{1,4}/g) ?? [n]).join(' ').toLowerCase()
}

const freshNumber = (): string => `1Z${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`

interface Store {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  admin: AdminClient
  ship: TestShipAdapter
  logs: LogCapture
}

async function openStore(
  ship: ShippingAdapter,
  relay: { maxAttempts?: number } = {},
): Promise<Store & { boot: LogCapture['calls'] }> {
  const logs = captureLogs()
  const k = await createKernel({
    dialect: 'sqlite',
    configure: customSlots('shipping'),
    logger: logs.logger,
    appOptions: { adapters: { shipping: ship }, relay },
  })
  const boot = [...logs.calls]
  const served = await serveKernel(k)
  const raw = openRaw(k.dialect, k.target)
  const admin = await adminClient(k, served.baseUrl)
  return { k, served, raw, admin, ship: ship as TestShipAdapter, logs, boot }
}

async function closeStore(s: Store | undefined): Promise<void> {
  await s?.raw.close()
  await s?.served.stop()
}

/** The calls made for `number` (normalised), in order. */
const callsFor = (ship: TestShipAdapter, number: string) =>
  ship.startCalls.filter((c) => c.trackingNumber === normaliseTrackingNumber(number))

describe('AC-4: shipping registers the number once', () => {
  let s: Store

  beforeAll(async () => {
    s = await openStore(createTestShipAdapter())
  }, 60_000)
  afterAll(() => closeStore(s))

  it('AC-4: property: an order shipped through POST /api/admin/orders/:id/ship with a spaced, lower-case number n and carrier c calls startTracking once with normaliseTrackingNumber(n) and c, and k = 1-5 redeliveries of its order.shipped.v1 make no second call', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('USPS', 'ups', 'Royal Mail', 'Acme Freight'),
        fc.integer({ min: 1, max: 5 }),
        async (carrier, redeliveries) => {
          const order = await processingOrder(s.k)
          const n = freshNumber()

          const answer = await shipThroughAdmin(s.admin, order.id, typed(n), carrier)
          await drained(s.k, s.raw)
          const once = callsFor(s.ship, n)
          const [event] = await shippedEvents(s.raw, order.id)
          for (let i = 0; i < redeliveries; i += 1) await s.k.eventBus.publish(event!.envelope)

          expect(answer).toEqual([200, 'shipped'])
          expect(once).toEqual([{ trackingNumber: normaliseTrackingNumber(typed(n)), carrier }])
          expect(callsFor(s.ship, n)).toEqual(once)
          expect(await processedBy(s.raw, START_TRACKING_HANDLER, event!.id)).toBe(1)
        },
      ),
      { numRuns: 8 },
    )
  }, 120_000)

  it('AC-4: property: with n = 1-3 rejections before success, the relay retries until startTracking succeeds: n + 1 calls, the event delivered after n counted failures, the shipped email handled once, and the order shipped with its history as the ship left it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (rejections) => {
        const order = await processingOrder(s.k)
        const n = freshNumber()
        s.ship.rejectNext(rejections, 'test-ship: 503 Service Unavailable')

        const answer = await shipThroughAdmin(s.admin, order.id, typed(n), 'USPS')
        const afterShip = await orderState(s.raw, order.id)
        await drained(s.k, s.raw)

        const [event] = await shippedEvents(s.raw, order.id)
        const answers = s.ship.startAnswers.slice(-(rejections + 1))
        expect(answer).toEqual([200, 'shipped'])
        expect(callsFor(s.ship, n).length).toBe(rejections + 1)
        expect(answers).toEqual([...Array<string>(rejections).fill('rejected'), 'tracking'])
        expect([event!.attempts, event!.deadAt == null, event!.deliveredAt != null]).toEqual([
          rejections,
          true,
          true,
        ])
        expect(await processedBy(s.raw, 'email:order-shipped', event!.id)).toBe(1)
        expect(await processedBy(s.raw, START_TRACKING_HANDLER, event!.id)).toBe(1)
        expect(await orderState(s.raw, order.id)).toEqual(afterShip)
        expect(afterShip[0]).toBe('shipped')
      }),
      { numRuns: 5 },
    )
  }, 120_000)

  it('AC-4: a refused answer whose reason holds the number, as sent and as typed: one call, no retry, one warn line naming the order with the number replaced by ***, and no warn or error line holding the number; the order stays shipped', async () => {
    const order = await processingOrder(s.k)
    const n = freshNumber()
    const asTyped = typed(n)
    s.ship.refuse(
      (p) => `tracking_number ${p.trackingNumber} is invalid (you entered "${asTyped}")`,
    )
    const logged = s.logs.calls.length

    try {
      const answer = await shipThroughAdmin(s.admin, order.id, asTyped, 'USPS')
      await drained(s.k, s.raw)

      const [event] = await shippedEvents(s.raw, order.id)
      const lines = s.logs.calls
        .slice(logged)
        .filter((c) => c.level === 'warn' || c.level === 'error')
      const naming = lines.filter((c) => stringsIn([c]).some((t) => t.includes(order.id)))
      const strings = stringsIn(lines)
      expect(answer).toEqual([200, 'shipped'])
      expect(callsFor(s.ship, n).length).toBe(1)
      expect([event!.attempts, event!.deliveredAt != null]).toEqual([0, true])
      expect(naming.length, JSON.stringify(lines)).toBe(1)
      expect(stringsIn(naming).some((t) => t.includes('***'))).toBe(true)
      expect(
        strings.filter((t) => t.includes(normaliseTrackingNumber(n)) || t.includes(asTyped)),
      ).toEqual([])
      expect((await orderState(s.raw, order.id))[0]).toBe('shipped')
    } finally {
      s.ship.refuse(null)
    }
  }, 60_000)
})

describe('AC-4: an outage longer than maxAttempts holds the registration', () => {
  let s: Store

  beforeAll(async () => {
    s = await openStore(createTestShipAdapter(), { maxAttempts: 2 })
  }, 60_000)
  afterAll(() => closeStore(s))

  // Kills: an outage longer than the relay's tries killing the registration, so the provider never learns the number.
  it('AC-4: with the shipping adapter’s health down and startTracking rejecting 3 times (relay maxAttempts 2), the event is not dead; once health is healthy the call succeeds, exactly one call answered tracking, and the event is delivered', async () => {
    const order = await processingOrder(s.k)
    const n = freshNumber()
    s.ship.down('test-ship: unreachable')
    s.ship.rejectNext(3, 'test-ship: connection refused')

    const answer = await shipThroughAdmin(s.admin, order.id, typed(n), 'USPS')
    await vi.waitFor(
      async () => {
        await s.k.app.relay.drain()
        expect(callsFor(s.ship, n).length).toBeGreaterThanOrEqual(3)
      },
      { timeout: 15_000, interval: 20 },
    )
    const [during] = await shippedEvents(s.raw, order.id)
    s.ship.up()
    await drained(s.k, s.raw)
    const [after] = await shippedEvents(s.raw, order.id)

    expect(answer).toEqual([200, 'shipped'])
    expect(during!.deadAt).toBeNull()
    expect(during!.attempts).toBeLessThan(2)
    expect(s.ship.startAnswers.filter((a) => a === 'tracking').length).toBe(1)
    expect(s.ship.startAnswers).toEqual(['rejected', 'rejected', 'rejected', 'tracking'])
    expect([after!.deadAt == null, after!.deliveredAt != null]).toEqual([true, true])
    expect((await orderState(s.raw, order.id))[0]).toBe('shipped')
  }, 60_000)
})

describe('AC-4: a custom adapter that declares tracking without startTracking', () => {
  let s: Store & { boot: LogCapture['calls'] }
  let control: Store & { boot: LogCapture['calls'] }

  beforeAll(async () => {
    s = await openStore(createTestShipAdapter({ methods: ['rate', 'createLabel'] }))
    control = await openStore(createTestShipAdapter())
  }, 60_000)
  afterAll(async () => {
    await closeStore(s)
    await closeStore(control)
  })

  it('AC-4: logs one more warn line at startup than the same adapter with startTracking, subscribes nothing for order.shipped.v1, and shipping works', async () => {
    const warns = (calls: LogCapture['calls']) => calls.filter((c) => c.level === 'warn').length
    const order = await processingOrder(s.k)

    const answer = await shipThroughAdmin(s.admin, order.id, typed(freshNumber()), 'USPS')
    await drained(s.k, s.raw)

    const [event] = await shippedEvents(s.raw, order.id)
    expect(warns(s.boot)).toBe(warns(control.boot) + 1)
    expect(answer).toEqual([200, 'shipped'])
    expect([event!.attempts, event!.deliveredAt != null]).toEqual([0, true])
    expect(await processedBy(s.raw, START_TRACKING_HANDLER, event!.id)).toBe(0)
  }, 60_000)
})

function keylessEasyPost(config: NymbalConfig): NymbalConfig {
  return nymbalConfigSchema.parse({
    ...config,
    commerce: {
      ...config.commerce,
      shipping: { provider: 'easypost', config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET } },
    },
  })
}

describe('AC-5: no tracking word, no registration', () => {
  const stores: Array<{ name: string; s: Store }> = []

  beforeAll(async () => {
    const open = async (
      name: string,
      configure?: (c: NymbalConfig) => NymbalConfig,
      ship?: ShippingAdapter,
    ) => {
      const logs = captureLogs()
      const k = await createKernel({
        dialect: 'sqlite',
        ...(configure !== undefined && { configure }),
        logger: logs.logger,
        ...(ship !== undefined && { appOptions: { adapters: { shipping: ship } } }),
      })
      const served = await serveKernel(k)
      const raw = openRaw(k.dialect, k.target)
      stores.push({
        name,
        s: {
          k,
          served,
          raw,
          admin: await adminClient(k, served.baseUrl),
          ship: ship as TestShipAdapter,
          logs,
        },
      })
    }
    await open('native')
    await open('keyless easypost', keylessEasyPost)
    await open(
      'not configured',
      customSlots('shipping'),
      createNotConfiguredAdapter('shipping', 'easypost', ['apiKey']) as ShippingAdapter,
    )
    await open('test-ship with tracking', customSlots('shipping'), createTestShipAdapter())
  }, 90_000)
  afterAll(async () => {
    for (const { s } of stores) await closeStore(s)
  })

  // Kills: a handler keyed on the method alone, which the not-configured adapter answers with a refusing function, so
  // every ship fails or dead-letters.
  it('AC-5: on native, keyless EasyPost and a not-configured shipping adapter, a shipped order’s event is delivered first time with no registration handled, where the store whose adapter declares tracking handles one', async () => {
    const outcomes: Array<[string, unknown, number, boolean, number]> = []
    for (const { name, s } of stores) {
      const order = await processingOrder(s.k)
      const [status] = await shipThroughAdmin(s.admin, order.id, typed(freshNumber()), 'USPS')
      await drained(s.k, s.raw)
      const [event] = await shippedEvents(s.raw, order.id)
      outcomes.push([
        name,
        status,
        event!.attempts,
        event!.deliveredAt != null,
        await processedBy(s.raw, START_TRACKING_HANDLER, event!.id),
      ])
    }

    expect(outcomes).toEqual([
      ['native', 200, 0, true, 0],
      ['keyless easypost', 200, 0, true, 0],
      ['not configured', 200, 0, true, 0],
      ['test-ship with tracking', 200, 0, true, 1],
    ])
  }, 60_000)

  it('AC-5: a keyless EasyPost store still delivers a shipped order from a signed delivered tracker post', async () => {
    const { s } = stores.find((x) => x.name === 'keyless easypost')!
    const order = await processingOrder(s.k)
    const n = `9400${randomUUID().replace(/\D/g, '').padEnd(18, '1').slice(0, 18)}`
    await shipThroughAdmin(s.admin, order.id, n, 'USPS')
    await drained(s.k, s.raw)
    const before = await orderState(s.raw, order.id)

    const posted = await postDelivery(
      s.served.baseUrl,
      'easypost',
      signedPost(trackerEvent(n, 'delivered')),
    )
    await drained(s.k, s.raw)

    expect(posted.status).toBe(200)
    expect(before[0]).toBe('shipped')
    expect(await orderState(s.raw, order.id)).toEqual([
      'delivered',
      [...before[1], ['shipped', 'delivered', 'system:shipping-tracking']],
    ])
  }, 60_000)
})
