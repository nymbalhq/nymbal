import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import {
  changeOneByte,
  EASYPOST_TEST_WEBHOOK_SECRET,
  easypostRequest,
  eventBody,
  signEasyPost,
  signedPost,
  trackerEvent,
} from '../../../../tests/support/easypost.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { postDelivery } from '../support/inbound-webhooks.js'
import { address, createKernel, kernelConfig, type Kernel } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { cleanupGraphDirs, runGraphChild } from '../support/primitive-graph.js'
import { openRaw, type RawReader } from '../support/raw.js'

// `shipping.provider: 'easypost'` passes the config's validation and createApp builds the shipping slot from
// @nymbalhq/adapter-easypost with the config block's webhook secret, so EasyPost's signed tracker posts to
// /api/webhooks/easypost reach the kernel's tracking handler: a delivered update delivers the shipped order with that
// tracking number, an in-transit one and a forged one leave it shipped. Without the package, startup fails naming its
// install line, with no SDK beside it. The missing-package case runs createApp from the built dist in a child process
// (fixtures/primitive-graph). Needs `pnpm build`.

afterAll(cleanupGraphDirs)

/** The kernel config with shipping on EasyPost, parsed: the schema must accept the provider and its block. */
function withEasyPost(config: NymbalConfig): NymbalConfig {
  return nymbalConfigSchema.parse({
    ...config,
    commerce: {
      ...config.commerce,
      shipping: { provider: 'easypost', config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET } },
    },
  })
}

/** Every event appended has been handed to the bus (or given up on), so every handler run that will happen has. */
async function settled(raw: RawReader): Promise<void> {
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
  const trackingNumber = `94001${randomUUID().replace(/-/g, '').slice(0, 17).toUpperCase()}`
  await k.services.order.importOrder({
    orderId: id,
    orderNumber: `EASYPOST-${randomUUID().slice(0, 8)}`,
    status: 'processing',
    customerId: null,
    email: `buyer-${randomUUID()}@easypost.test`,
    billingAddress: address,
    shippingAddress: address,
    lineItems: [
      {
        variantId: randomUUID(),
        productId: randomUUID(),
        productName: 'Parcel Widget',
        variantName: 'Default',
        sku: 'PARCEL-1',
        qty: 1,
        unitPriceMinor: 1200,
        lineSubtotalMinor: 1200,
        lineTaxMinor: 0,
        lineTotalMinor: 1200,
        imageUrl: '',
      },
    ],
    subtotalMinor: 1200,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 1200,
    currency: 'GBP',
    createdAt: new Date(),
    capturedMinor: 1200,
    captureMethod: 'import',
  })
  await k.services.order.markShipped(id, trackingNumber, 'USPS', 'admin:easypost')
  return { id, trackingNumber }
}

/** [status, delivered history rows by the tracking handler] for the order. */
async function stateOf(raw: RawReader, orderId: string): Promise<[string, number]> {
  const { status } = await raw.one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [
    orderId,
  ])
  return [
    status,
    await raw.count(
      'order_history',
      "order_id = ? AND to_status = 'delivered' AND actor = 'system:shipping-tracking'",
      [orderId],
    ),
  ]
}

describe('AC-4: the easypost provider loads', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite', configure: withEasyPost })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  it("AC-4: shipping { provider: 'easypost' } validates and createApp's shipping adapter is easypost's", () => {
    expect(k.config.commerce.shipping.provider).toBe('easypost')
    expect(k.app.adapters.shipping.providerName).toBe(k.config.commerce.shipping.provider)
  })

  it('AC-4: a signed delivered tracker.updated for a shipped order’s number, posted to /api/webhooks/easypost, delivers it; a forged one and an in-transit one before it leave it shipped', async () => {
    const order = await shippedOrder(k)
    await settled(raw)
    const before = await stateOf(raw, order.id)

    const deliveredBody = eventBody(trackerEvent(order.trackingNumber, 'delivered'))
    const forged = await postDelivery(
      served.baseUrl,
      'easypost',
      easypostRequest(
        changeOneByte(Buffer.from(deliveredBody, 'utf8'), deliveredBody.indexOf('delivered')),
        signEasyPost(deliveredBody, EASYPOST_TEST_WEBHOOK_SECRET),
      ),
    )
    const moving = await postDelivery(
      served.baseUrl,
      'easypost',
      signedPost(trackerEvent(order.trackingNumber, 'in_transit')),
    )
    await settled(raw)
    const afterMoving = await stateOf(raw, order.id)
    const delivered = await postDelivery(
      served.baseUrl,
      'easypost',
      easypostRequest(deliveredBody, signEasyPost(deliveredBody, EASYPOST_TEST_WEBHOOK_SECRET)),
    )
    await settled(raw)
    const after = await stateOf(raw, order.id)

    expect(
      [forged.status, moving.status, delivered.status],
      JSON.stringify([forged.body, moving.body, delivered.body]),
    ).toEqual([400, 200, 200])
    expect([moving.data, delivered.data]).toEqual([
      { received: true, events: 1 },
      { received: true, events: 1 },
    ])
    expect(before).toEqual(['shipped', 0])
    expect(afterMoving).toEqual(before)
    expect(after).toEqual(['delivered', before[1] + 1])
  })
})

describe('AC-4: the easypost provider without its package', () => {
  it('AC-4: with @nymbalhq/adapter-easypost not installed, createApp fails adapter.package_missing, naming the shipping slot and "npm install @nymbalhq/adapter-easypost" with no SDK after it', async () => {
    const { outcome } = await runGraphChild(withEasyPost(kernelConfig('sqlite')), {
      hide: ['@nymbalhq/adapter-easypost'],
    })

    expect(outcome.started, JSON.stringify(outcome.started)).toBeUndefined()
    expect(outcome.error?.code, outcome.error?.message).toBe('adapter.package_missing')
    expect(outcome.error?.message).toMatch(/\bshipping\b/)
    const install = /npm install [^\n]*/.exec(outcome.error?.message ?? '')?.[0]
    expect(install?.trim(), outcome.error?.message).toBe('npm install @nymbalhq/adapter-easypost')
  }, 90_000)
})
