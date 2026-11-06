import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import {
  FAKE_AFTERSHIP_API_KEY,
  startFakeAfterShip,
  TRACKINGS_PATH,
  type FakeAfterShip,
} from '../../../adapters/shipping/aftership/src/tests/fake-aftership.js'
import {
  FAKE_EASYPOST_API_KEY,
  startFakeEasyPost,
  type FakeEasyPost,
} from '../../../adapters/shipping/easypost/src/tests/fake-easypost.js'
import {
  AFTERSHIP_TEST_WEBHOOK_SECRET,
  signedPost as signedAfterShipPost,
  trackingUpdate,
} from '../../../../tests/support/aftership.js'
import {
  EASYPOST_TEST_WEBHOOK_SECRET,
  signedPost as signedEasyPostPost,
  trackerEvent,
} from '../../../../tests/support/easypost.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { postDelivery } from '../support/inbound-webhooks.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  drained,
  orderState,
  processingOrder,
  shipThroughAdmin,
} from '../support/shipping-orders.js'

// A number the merchant typed by hand reaches `delivered` through the provider's webhook: the store's shipping block
// names the provider package with its API key and a fake of the provider's API, the admin's ship action registers the
// number there once, and the provider's signed post for that number delivers the order. Loads the built packages
// (`pnpm build`): the kernel imports @nymbalhq/shipping-easypost and @nymbalhq/shipping-aftership from dist.

function withShipping(provider: string, config: Record<string, unknown>) {
  return (base: NymbalConfig): NymbalConfig =>
    nymbalConfigSchema.parse({
      ...base,
      commerce: { ...base.commerce, shipping: { provider, config } },
    })
}

interface Store {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  admin: AdminClient
}

async function open(configure: (c: NymbalConfig) => NymbalConfig): Promise<Store> {
  const k = await createKernel({ dialect: 'sqlite', configure })
  const served = await serveKernel(k)
  return {
    k,
    served,
    raw: openRaw(k.dialect, k.target),
    admin: await adminClient(k, served.baseUrl),
  }
}

describe('AC-6: a hand-typed number reaches delivered through EasyPost', () => {
  let fake: FakeEasyPost
  let s: Store

  beforeAll(async () => {
    fake = await startFakeEasyPost()
    s = await open(
      withShipping('easypost', {
        apiKey: FAKE_EASYPOST_API_KEY,
        webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET,
        apiBase: fake.apiBase,
      }),
    )
  }, 60_000)
  afterAll(async () => {
    await s?.raw.close()
    await s?.served.stop()
    await fake?.close()
  })

  it('AC-6: an order shipped through the admin route with "9400 1000 0000 0000 0000 01" and USPS makes EasyPost record one POST /v2/trackers { tracker: { tracking_code, carrier: USPS } } under Basic auth with the key; a signed delivered tracker.updated for that code to /api/webhooks/easypost then delivers it', async () => {
    const order = await processingOrder(s.k)
    const before = fake.requests.length

    const shipped = await shipThroughAdmin(s.admin, order.id, '9400 1000 0000 0000 0000 01', 'USPS')
    await drained(s.k, s.raw)
    const registered = fake.requests.slice(before).filter((r) => r.path === '/v2/trackers')
    const afterShip = await orderState(s.raw, order.id)
    const posted = await postDelivery(
      s.served.baseUrl,
      'easypost',
      signedEasyPostPost(trackerEvent('9400100000000000000001', 'delivered')),
    )
    await drained(s.k, s.raw)

    expect(shipped).toEqual([200, 'shipped'])
    expect(registered.map((r) => [r.method, r.body, r.authorization, r.status])).toEqual([
      [
        'POST',
        { tracker: { tracking_code: '9400100000000000000001', carrier: 'USPS' } },
        `Basic ${Buffer.from(`${FAKE_EASYPOST_API_KEY}:`).toString('base64')}`,
        200,
      ],
    ])
    expect(posted.status).toBe(200)
    expect(await orderState(s.raw, order.id)).toEqual([
      'delivered',
      [...afterShip[1], ['shipped', 'delivered', 'system:shipping-tracking']],
    ])
  }, 60_000)
})

describe('AC-14: the aftership provider loads and delivers', () => {
  let fake: FakeAfterShip
  let s: Store

  beforeAll(async () => {
    fake = await startFakeAfterShip()
    s = await open(
      withShipping('aftership', {
        apiKey: FAKE_AFTERSHIP_API_KEY,
        webhookSecret: AFTERSHIP_TEST_WEBHOOK_SECRET,
        apiBase: fake.apiBase,
      }),
    )
  }, 60_000)
  afterAll(async () => {
    await s?.raw.close()
    await s?.served.stop()
    await fake?.close()
  })

  it("AC-14: shipping { provider: 'aftership', config } builds the adapter from @nymbalhq/shipping-aftership, declaring tracking", () => {
    const shipping = s.k.app.adapters.shipping

    expect(shipping.providerName).toBe(s.k.config.commerce.shipping.provider)
    expect([...shipping.capabilities()]).toEqual(['tracking'])
  })

  it('AC-14: an order shipped through the admin route makes AfterShip record one registration with the slug, and a signed delivered tracking_update for its number, posted to /api/webhooks/aftership, delivers it', async () => {
    const order = await processingOrder(s.k)
    const before = fake.requests.length

    const shipped = await shipThroughAdmin(s.admin, order.id, '1z 999a a101 2345 6784', 'UPS')
    await drained(s.k, s.raw)
    const registered = fake.requests.slice(before).filter((r) => r.path === TRACKINGS_PATH)
    const afterShip = await orderState(s.raw, order.id)
    const posted = await postDelivery(
      s.served.baseUrl,
      'aftership',
      signedAfterShipPost(trackingUpdate('1Z999AA10123456784', 'Delivered', { slug: 'ups' })),
    )
    await drained(s.k, s.raw)

    expect(shipped).toEqual([200, 'shipped'])
    expect(registered.map((r) => [r.method, r.body, r.apiKey])).toEqual([
      ['POST', { tracking_number: '1Z999AA10123456784', slug: 'ups' }, FAKE_AFTERSHIP_API_KEY],
    ])
    expect([posted.status, posted.data]).toEqual([200, { received: true, events: 1 }])
    expect(await orderState(s.raw, order.id)).toEqual([
      'delivered',
      [...afterShip[1], ['shipped', 'delivered', 'system:shipping-tracking']],
    ])
  }, 60_000)
})
