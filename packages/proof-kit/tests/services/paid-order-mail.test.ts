import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMailSink, type MailSink } from '@nymbalhq/proof-kit/mail'
import { startTestStore, type TestStore } from '@nymbalhq/proof-kit/store'
import { storefrontClient } from '../fixtures/storefront-client'

// AC-10: a shopper's paid order, made only through the store's own API (cart, item, checkout; no webhook call and no
// proof-kit payment hook, which this file does not import), leaves one order-placed message in the mail sink, and the
// order it names is confirmed. "One" is read after a barrier: a registration whose welcome email has arrived,
// delivered after every event the checkout published.
// The file refuses to load without NYMBAL_TEST_MAILPIT_URL, so a missing Mailpit fails the project.

const URL_VAR = 'NYMBAL_TEST_MAILPIT_URL'
const mailpitUrl = process.env[URL_VAR]
if (mailpitUrl === undefined || mailpitUrl.trim() === '') {
  throw new Error(
    `${URL_VAR} is not set: the proof-kit-services project needs Mailpit ` +
      `(pnpm gate:full starts one with docker compose; e.g. ${URL_VAR}=http://localhost:18025)`,
  )
}

const address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

let sink: MailSink
let store: TestStore

beforeAll(async () => {
  sink = createMailSink()
  store = await startTestStore({ email: sink })
}, 30_000)

afterAll(async () => {
  await store?.stop()
})

describe('AC-10: a paid order emails once, through the product alone', () => {
  // Kills: the email sent at placement (for an order still pending), sent twice, or only sent once a test posts the
  // payment hook.
  it('AC-10: a checkout over the API alone confirms the order and leaves exactly one order-placed message naming it', async () => {
    const product = await store.app.services.product.create({
      slug: `ac10-${randomUUID()}`,
      name: 'Paid Once',
      description: '',
      status: 'active',
      variants: [
        { sku: `AC10-${randomUUID()}`, name: 'Default', priceMinor: 2350, stock: 3, options: [] },
      ],
    })
    const buyer = `ac10-${randomUUID()}@proof-kit.test`
    const shopper = storefrontClient(store.baseUrl)
    const before = (await sink.messages({ to: buyer })).length
    expect((await shopper.call('GET', '/api/cart')).status).toBe(200)
    const item = await shopper.call('POST', '/api/cart/items', {
      variantId: product.variants[0]!.id,
      qty: 1,
    })
    expect(item.status, JSON.stringify(item.body)).toBe(200)

    const placed = await shopper.call<{ orderNumber: string; orderKey: string }>(
      'POST',
      '/api/checkout',
      {
        email: buyer,
        billingAddress: address,
        shippingAddress: address,
      },
    )
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    const orderNumber = placed.body.data!.orderNumber
    const received = await sink.waitFor({ to: buyer }, { timeoutMs: 10_000 })
    const marker = `barrier-${randomUUID()}@proof-kit.test`
    await store.app.services.auth.register({ email: marker, password: 'password123' })
    await sink.waitFor({ to: marker }, { timeoutMs: 10_000 })
    const order = await shopper.call<{ orderNumber: string; status: string }>(
      'GET',
      `/api/orders/${orderNumber}`,
      undefined,
      { 'x-nymbal-order-key': placed.body.data!.orderKey },
    )

    expect(order.body.data?.status).toBe('confirmed')
    expect(received[0]!.subject).toContain(orderNumber)
    expect(order.body.data?.orderNumber).toBe(orderNumber)
    expect((await sink.messages({ to: buyer })).length).toBe(before + 1)
    expect(received).toHaveLength(1)
  }, 30_000)
})
