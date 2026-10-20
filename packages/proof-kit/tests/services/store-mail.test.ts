import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMailSink, type MailSink } from '@nymbalhq/proof-kit/mail'
import { startTestStore, type TestStore } from '@nymbalhq/proof-kit/store'
import { storefrontClient } from '../fixtures/storefront-client'

// Acceptance test for P1-01 AC-11: a store started with startTestStore({ email: sink }) sends the order-placed
// email for a checkout made over HTTP (cart, item, begin checkout) to the sink, exactly once, for the buyer.
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

describe('AC-11: the kit store sends kernel email to the sink', () => {
  // P2-01 AC-5: the kit store's mail goes out through the `smtp` provider (nodemailer left the kernel), so the AC-11
  // delivery below is SMTP mail sent by @nymbalhq/adapter-smtp.
  it('AC-5 (P2-01): the kit store started with a mail sink configures email as the smtp provider, and the sink as its config', () => {
    const email = store.app.platform.config.commerce.email
    expect(email.provider).toBe('smtp')
    expect(email.config).toEqual(sink.emailConfig())
  })

  it('AC-11: a checkout over HTTP (cart, item, begin checkout) delivers the order-placed email exactly once to the buyer', async () => {
    const product = await store.app.services.product.create({
      slug: `mail-${randomUUID()}`,
      name: 'Mail Widget',
      description: '',
      status: 'active',
      variants: [
        { sku: `MAIL-${randomUUID()}`, name: 'Default', priceMinor: 990, stock: 4, options: [] },
      ],
    })
    const buyer = `ac11-${randomUUID()}@proof-kit.test`
    const shopper = storefrontClient(store.baseUrl)
    const before = await sink.messages({ to: buyer })

    const cart = await shopper.call('GET', '/api/cart')
    expect(cart.status, JSON.stringify(cart.body)).toBe(200)
    const item = await shopper.call('POST', '/api/cart/items', {
      variantId: product.variants[0]!.id,
      qty: 1,
    })
    expect(item.status, JSON.stringify(item.body)).toBe(200)
    const checkout = await shopper.call<{ orderNumber: string }>('POST', '/api/checkout', {
      email: buyer,
      billingAddress: address,
      shippingAddress: address,
    })
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200)
    const orderNumber = checkout.body.data!.orderNumber

    const received = await sink.waitFor({ to: buyer }, { timeoutMs: 10_000 })

    const after = await sink.messages({ to: buyer })

    expect(received).toHaveLength(1)
    expect(received[0]!.subject).toContain(orderNumber)
    expect(received[0]!.to).toContain(buyer)
    expect(after.length).toBe(before.length + 1)
  }, 30_000)
})
