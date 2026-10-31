import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EmailAdapter, ShippingAdapter } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { customSlots, postDelivery } from '../support/inbound-webhooks.js'
import { address, createKernel, type Kernel } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { createTestHooksAdapter, signedDelivery } from '../support/test-hooks.js'
import { createTestMailAdapter } from '../support/test-mail.js'
import { createTestShipAdapter } from '../support/test-ship.js'

// Only the shipping slot's own adapter can deliver an order: a tracking event of the shipping adapter's name that comes
// from another slot, or that names a shipping adapter taking no webhooks, moves nothing. Read as outcomes: the shipped
// order, findable by its number, stays shipped with no delivered history row.

const trackingPayload = (trackingNumber: string) => ({
  trackingNumber,
  carrier: null,
  status: 'delivered',
  occurredAt: new Date().toISOString(),
})

async function delivered(raw: RawReader): Promise<void> {
  await vi.waitFor(
    async () => {
      const open = (await eventRows(raw)).filter((r) => r.deliveredAt == null && r.deadAt == null)
      expect(open.map((r) => r.type)).toEqual([])
    },
    { timeout: 10_000, interval: 20 },
  )
}

/** A processing order shipped through the order service with a fresh tracking number. */
async function shippedOrder(k: Kernel): Promise<{ id: string; trackingNumber: string }> {
  const id = randomUUID()
  const trackingNumber = `1Z${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`
  await k.services.order.importOrder({
    orderId: id,
    orderNumber: `SLOTS-${randomUUID().slice(0, 8)}`,
    status: 'processing',
    customerId: null,
    email: `buyer-${randomUUID()}@slots.test`,
    billingAddress: address,
    shippingAddress: address,
    lineItems: [
      {
        variantId: randomUUID(),
        productId: randomUUID(),
        productName: 'Slots Widget',
        variantName: 'Default',
        sku: 'SLOTS-1',
        qty: 1,
        unitPriceMinor: 900,
        lineSubtotalMinor: 900,
        lineTaxMinor: 0,
        lineTotalMinor: 900,
        imageUrl: '',
      },
    ],
    subtotalMinor: 900,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 900,
    currency: 'GBP',
    createdAt: new Date(),
    capturedMinor: 900,
    captureMethod: 'import',
  })
  await k.services.order.markShipped(id, trackingNumber, 'UPS', 'admin:slots')
  return { id, trackingNumber }
}

/** [status, delivered history rows, shipment rows naming the number] for the order. */
async function stateOf(raw: RawReader, orderId: string, trackingNumber: string) {
  const { status } = await raw.one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [
    orderId,
  ])
  return [
    status,
    await raw.count('order_history', "order_id = ? AND to_status = 'delivered'", [orderId]),
    await raw.count('order_shipments', 'order_id = ? AND tracking_number = ?', [
      orderId,
      trackingNumber,
    ]),
  ]
}

/** How many events of `type` the log holds. */
async function trackingEvents(raw: RawReader, type: string): Promise<number> {
  return raw.count('events', 'type = ?', [type])
}

describe('a tracking update from another slot under the shipping adapter’s name', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader

  beforeAll(async () => {
    // The shipping adapter is named acme and takes no webhooks (its receiveWebhook is undefined, which the route counts
    // as hookless); the email adapter, also acme, takes them, hands on what it is sent, and declares acme.tracking.v1.
    const hooks = createTestHooksAdapter({
      providerName: 'acme',
      producesEvents: ['acme.tracking.v1'],
    })
    const email: EmailAdapter = {
      ...createTestMailAdapter({ providerName: 'acme', producesEvents: ['acme.tracking.v1'] }),
      receiveWebhook: hooks.receiveWebhook!,
    }
    k = await createKernel({
      dialect: 'sqlite',
      configure: customSlots('email', 'shipping'),
      appOptions: {
        adapters: {
          email,
          shipping: {
            ...createTestShipAdapter({ providerName: 'acme' }),
            receiveWebhook: undefined,
            // The type leaves the hook out rather than undefined; the route must count an undefined one as hookless too.
          } as unknown as ShippingAdapter,
        },
      },
    })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  it('AC-8: a signed acme.tracking.v1 delivered update for a shipped order’s number from the hooked email adapter acme is received, but the order, its shipment recorded, stays shipped with no delivered history row', async () => {
    const order = await shippedOrder(k)
    await delivered(raw)
    const before = await stateOf(raw, order.id, order.trackingNumber)
    const logged = await trackingEvents(raw, 'acme.tracking.v1')

    const answer = await postDelivery(
      served.baseUrl,
      'acme',
      signedDelivery({
        id: `dlv_${randomUUID()}`,
        events: [{ type: 'acme.tracking.v1', payload: trackingPayload(order.trackingNumber) }],
      }),
    )
    await delivered(raw)

    expect([answer.status, answer.data], JSON.stringify(answer.body)).toEqual([
      200,
      { received: true, events: 1 },
    ])
    expect(await trackingEvents(raw, 'acme.tracking.v1')).toBe(logged + 1)
    expect(before).toEqual(['shipped', 0, 1])
    expect(await stateOf(raw, order.id, order.trackingNumber)).toEqual(before)
  })
})

describe('a tracking event under the native shipping adapter’s name', () => {
  let k: Kernel
  let raw: RawReader

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await k?.close()
  })

  it('AC-8: on a native shipping store, a native.tracking.v1 delivered update for a shipped order’s number published to the log leaves the order, its shipment recorded, shipped with no delivered history row', async () => {
    const order = await shippedOrder(k)
    await delivered(raw)
    const before = await stateOf(raw, order.id, order.trackingNumber)
    const logged = await trackingEvents(raw, 'native.tracking.v1')

    await k.publisher.publishUntyped(
      [{ type: 'native.tracking.v1', payload: trackingPayload(order.trackingNumber) }],
      { source: 'webhook:native' },
    )
    await delivered(raw)

    expect(await trackingEvents(raw, 'native.tracking.v1')).toBe(logged + 1)
    expect(before).toEqual(['shipped', 0, 1])
    expect(await stateOf(raw, order.id, order.trackingNumber)).toEqual(before)
  })
})
