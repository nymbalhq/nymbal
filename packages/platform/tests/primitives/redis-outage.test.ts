import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { EVT_ORDER_PAID } from '@nymbalhq/types'
import { deleteUnder, redisServerUrl, uniquePrefix } from '../../../../tests/support/redis'
import { closeBounded, tcpProxy, type TcpProxy } from '../../../../tests/support/tcp-proxy'
import { createLogger } from '../../src/logger.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, type Kernel } from '../support/kernel.js'
import { eventRows, maxSeq } from '../support/outbox.js'
import { withInfrastructure } from '../support/primitive-graph.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { createTestMailAdapter, type TestMailAdapter } from '../support/test-mail.js'

// AC-5: a Redis outage loses nothing. A kernel on a SQLite command store with the Redis document store and the Redis
// Streams bus, both reaching the composed Redis through a TCP proxy, and the relay at maxAttempts 3, retryDelayMs
// 100 ms and a 100 ms pass interval. The proxy is closed for at least OUTAGE_MS while a product is created and a
// checkout is paid, and the test drains the relay over and over for the whole outage: each rejected publish takes
// about 600 ms (the bus client's one retry), so a relay that counts every rejection reaches its third failure well
// inside it. Once the proxy listens again, within 20 s every event is delivered and none is dead, the product is
// served over HTTP and the buyer has one order-placed email. Needs Redis (NYMBAL_TEST_REDIS_URL) and the build (the
// Redis primitives load their SDKs from their packages).

const OUTAGE_MS = 6000
const RECOVERY_MS = 20_000
const MAX_ATTEMPTS = 3

const redisUrl = redisServerUrl()
const prefix = uniquePrefix('redis-outage')

let proxy: TcpProxy
let mail: TestMailAdapter
let k: Kernel
let served: ServedKernel
let raw: RawReader

beforeAll(async () => {
  proxy = await tcpProxy(new URL(redisUrl))
  mail = createTestMailAdapter()
  k = await createKernel({
    dialect: 'sqlite',
    configure: (config) =>
      ({
        ...withInfrastructure(config, {
          commandStore: 'sqlite',
          documentStore: { provider: 'redis' },
          eventBus: { provider: 'redis-streams' },
          redis: { url: proxy.url(redisUrl), prefix, ackTimeoutMs: 4000, claimIdleMs: 400 },
        }),
        commerce: { ...config.commerce, email: { provider: 'custom' } },
      }) as NymbalConfig,
    appOptions: {
      adapters: { email: mail },
      relay: { maxAttempts: MAX_ATTEMPTS, retryDelayMs: 100, intervalMs: 100 },
    },
    // Every rejected publish and handler failure in the outage is logged at error.
    logger: createLogger({ pretty: false, level: 'silent' }),
  })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await proxy?.reopen()
  if (served !== undefined) await closeBounded(() => served.stop(), 10_000)
  await proxy?.close()
  await deleteUnder(redisUrl, prefix)
})

describe('AC-5: a Redis outage on the document store and the bus', () => {
  it(`AC-5: with Redis unreachable for at least ${OUTAGE_MS} ms while a product is created and a checkout is paid, and the relay drained throughout, within ${RECOVERY_MS} ms of Redis returning every event is delivered and none is dead, GET /api/products/:slug serves the product, and the buyer has one order-placed email`, async () => {
    const tag = randomUUID().slice(0, 8)
    const slug = `redis-outage-${tag}`
    const buyer = `buyer-${tag}@outage.test`
    // The cart exists before the outage; every command after the close commits during it.
    const { token: cartToken } = await k.services.cart.getOrCreate()
    const before = await maxSeq(raw)

    await proxy.close()
    const closedAt = Date.now()
    let outage = true
    const draining = (async () => {
      while (outage) {
        await k.app.relay.drain()
        // A pass with nothing due returns at once: a short pause keeps the loop from spinning.
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })()

    const product = await k.services.product.create({
      slug,
      name: 'Redis outage product',
      description: '',
      status: 'active',
      variants: [
        {
          sku: `OUTAGE-${tag}`,
          name: 'Default',
          priceMinor: 1500,
          stock: 5,
          lowStockThreshold: 0,
          options: [],
        },
      ],
    })
    const variant = product.variants[0]!
    await k.services.cart.addItem(cartToken, {
      variantId: variant.id,
      productId: product.id,
      productName: product.name,
      variantName: variant.name,
      priceMinor: variant.priceMinor,
      imageUrl: '',
      qty: 1,
    })
    // No `+stub-pending`: the stub pays inline, so order.paid.v1 commits with the checkout.
    const started = await k.services.checkout.beginCheckout({
      cartToken,
      email: buyer,
      billingAddress: address,
      shippingAddress: address,
    })
    const committed = await eventRows(raw, 'seq > ?', [before])
    expect(
      committed.filter((r) => r.type === EVT_ORDER_PAID).length,
      'the paid checkout committed during the outage',
    ).toBe(1)

    // The outage is a duration the criterion sets, not a wait for something to happen.
    await vi.waitUntil(() => Date.now() - closedAt >= OUTAGE_MS, {
      timeout: OUTAGE_MS + 30_000,
      interval: 50,
    })
    outage = false
    const outageMs = Date.now() - closedAt
    await proxy.reopen()
    await draining

    const settled = async () => {
      const rows = await eventRows(raw, 'seq > ?', [before])
      return rows.every((r) => r.deliveredAt != null || r.deadAt != null) ? rows : undefined
    }
    const rows = await vi.waitUntil(settled, { timeout: RECOVERY_MS, interval: 100 })

    expect(outageMs).toBeGreaterThanOrEqual(OUTAGE_MS)
    expect(
      rows.filter((r) => r.deadAt != null).map((r) => `${r.type} after ${r.attempts}`),
      'events dead after the outage',
    ).toEqual([])
    expect(rows.length, 'events delivered').toBe(rows.filter((r) => r.deliveredAt != null).length)

    const res = await fetch(`${served.baseUrl}/api/products/${slug}`)
    const body = (await res.json()) as { data?: { id?: string } }
    expect([res.status, body.data?.id]).toEqual([200, product.id])

    const placed = mail.sent.filter((m) => m.template === 'order-placed' && m.to === buyer)
    expect(placed.map((m) => String(m.vars['orderNumber']))).toEqual([started.orderNumber])
  }, 180_000)
})
