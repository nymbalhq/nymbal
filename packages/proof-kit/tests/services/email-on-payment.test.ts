import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMailSink, type MailSink } from '@nymbalhq/proof-kit/mail'
import { finaliseStubPayment } from '@nymbalhq/proof-kit/payments'
import { startTestStore, type TestStore } from '@nymbalhq/proof-kit/store'
import { storefrontClient } from '../fixtures/storefront-client'

// P1-12 AC-2 on the kit store over HTTP, mail read from Mailpit: exactly one order-placed email per paid order and none
// for an unpaid one. The stub's default pays inline (one email); `+stub-pending` sends none until a captured payment
// arrives, then one; `+stub-decline` sends none. "None" and "exactly one" are read after a barrier: a registration
// whose welcome email has arrived, which the outbox delivers after every event the checkout published.
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

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  paymentIntent: { id: string }
  currency: string
  totalMinor: number
  orderStatus: string
  payment: { status: string; reason?: string }
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

/** Every event published so far has reached its handlers once this registration's welcome email is in Mailpit. */
async function barrier(): Promise<void> {
  const marker = `barrier-${randomUUID()}@proof-kit.test`
  await store.app.services.auth.register({ email: marker, password: 'password123' })
  await sink.waitFor({ to: marker }, { timeoutMs: 10_000 })
}

async function checkout(buyer: string) {
  const product = await store.app.services.product.create({
    slug: `ac2-${randomUUID()}`,
    name: 'Mail On Payment',
    description: '',
    status: 'active',
    variants: [
      { sku: `AC2-${randomUUID()}`, name: 'Default', priceMinor: 1450, stock: 5, options: [] },
    ],
  })
  const shopper = storefrontClient(store.baseUrl)
  expect((await shopper.call('GET', '/api/cart')).status).toBe(200)
  const item = await shopper.call('POST', '/api/cart/items', {
    variantId: product.variants[0]!.id,
    qty: 1,
  })
  expect(item.status, JSON.stringify(item.body)).toBe(200)
  const res = await shopper.call<CheckoutAnswer>('POST', '/api/checkout', {
    email: buyer,
    billingAddress: address,
    shippingAddress: address,
  })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

const mailTo = async (buyer: string) => (await sink.messages({ to: buyer })).length

describe('AC-2: one order-placed email per paid order, none for an unpaid one', () => {
  // Kills: the email sent at placement for an order that is not paid, or sent twice for one that is.
  it('AC-2: the stub default pays inline and leaves exactly one order-placed email naming the order, for a confirmed order', async () => {
    const buyer = `ac2-paid-${randomUUID()}@proof-kit.test`

    const answer = await checkout(buyer)
    const received = await sink.waitFor({ to: buyer }, { timeoutMs: 10_000 })
    await barrier()

    expect(answer.orderStatus).toBe('confirmed')
    expect(received[0]!.subject).toContain(answer.orderNumber)
    expect(await mailTo(buyer)).toBe(1)
  }, 30_000)

  it('AC-2: +stub-pending sends nothing at placement; a captured payment then sends exactly one', async () => {
    const buyer = `ac2-pending-${randomUUID()}+stub-pending@proof-kit.test`

    const answer = await checkout(buyer)
    await barrier()
    const atPlacement = await mailTo(buyer)
    const paid = await finaliseStubPayment(store.baseUrl, {
      paymentIntentId: answer.paymentIntent.id,
      amountMinor: answer.totalMinor,
      currency: answer.currency,
    })
    const received = await sink.waitFor({ to: buyer }, { timeoutMs: 10_000 })
    await barrier()

    expect(atPlacement).toBe(0)
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    expect(received[0]!.subject).toContain(answer.orderNumber)
    expect(await mailTo(buyer)).toBe(atPlacement + 1)
  }, 30_000)

  it('AC-2: +stub-decline sends no order-placed email', async () => {
    const buyer = `ac2-decline-${randomUUID()}+stub-decline@proof-kit.test`

    const answer = await checkout(buyer)
    await barrier()

    expect(await mailTo(buyer)).toBe(0)
    expect(answer.payment?.status).toBe('failed')
  }, 30_000)
})
