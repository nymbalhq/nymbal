import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Address } from '@nymbalhq/types'
// The built proof kit (the platform test support does the same with the http dist): a kernel on stub payments served
// over HTTP on a free port, and the stub webhook that finalises a payment through the real route.
import { startTestStore, type TestStore } from '../../proof-kit/dist/store.js'
import { finaliseStubPayment } from '../../proof-kit/dist/payments.js'
import { createNymbalClient, type NymbalClient } from '../src/index.js'

// P1-09 acceptance (AC-1, AC-2): the SDK's account calls against a running API. Each client is one shopper: its own
// token manager (memory), its own cart token, signed in through the SDK's own register.

let store: TestStore
const clients: NymbalClient[] = []

beforeAll(async () => {
  store = await startTestStore()
}, 30_000)

afterAll(async () => {
  for (const client of clients) client.destroy()
  await store?.stop()
})

interface Shopper {
  client: NymbalClient
  email: string
  setCartToken(token: string): void
}

async function signedInShopper(firstName: string): Promise<Shopper> {
  let cartToken: string | null = null
  const client = createNymbalClient({
    baseUrl: store.baseUrl,
    tokenStorage: 'memory',
    getCartToken: () => cartToken,
  })
  clients.push(client)
  const email = `p1-09-${randomUUID()}@sdk.test`
  await client.auth.register({
    email,
    password: 'correct-horse-battery',
    firstName,
    lastName: 'Buyer',
  })
  return {
    client,
    email,
    setCartToken(token) {
      cartToken = token
    },
  }
}

function addressOf(tag: string): Address {
  return {
    firstName: 'Ada',
    lastName: 'Buyer',
    addressLine1: `${tag} Acceptance Road`,
    city: 'London',
    region: `Region ${tag}`,
    postalCode: `E${tag.slice(0, 4).toUpperCase()}`,
    country: 'GB',
  }
}

describe('AC-1: SDK customer addresses against a running API', () => {
  it('AC-1: create then list round-trips addressLine1, region and postalCode; remove takes it out; another customer never sees it', async () => {
    const owner = await signedInShopper('Owner')
    const other = await signedInShopper('Other')
    const input = addressOf(randomUUID().slice(0, 8))

    const before = await owner.client.customer.addresses.list()
    const created = await owner.client.customer.addresses.create(input)
    const listed = await owner.client.customer.addresses.list()

    expect(listed.length).toBe(before.length + 1)
    const found = listed.find((a) => a.id === created.id)
    expect(found).toBeDefined()
    expect({
      addressLine1: found!.addressLine1,
      region: found!.region,
      postalCode: found!.postalCode,
    }).toEqual({
      addressLine1: input.addressLine1,
      region: input.region,
      postalCode: input.postalCode,
    })

    const othersList = await other.client.customer.addresses.list()
    expect(othersList.map((a) => a.id)).not.toContain(created.id)
    expect(othersList.map((a) => a.addressLine1)).not.toContain(input.addressLine1)

    await owner.client.customer.addresses.remove(created.id)
    const after = await owner.client.customer.addresses.list()
    expect(after.map((a) => a.id)).not.toContain(created.id)
    expect(after.length).toBe(listed.length - 1)
  }, 30_000)
})

describe('AC-2: SDK customer orders against a running API', () => {
  it('AC-2: a signed-in checkout, finalised by the stub, is in orders.list; orders.get returns lines summing to subtotal + tax; another customer does not list it', async () => {
    const buyer = await signedInShopper('Buyer')
    const other = await signedInShopper('Other')
    const tag = randomUUID()
    const product = await store.app.services.product.create({
      slug: `p1-09-${tag}`,
      name: 'Account Widget',
      description: '',
      status: 'active',
      variants: [
        { sku: `P109-A-${tag}`, name: 'Small', priceMinor: 1250, stock: 20, options: [] },
        { sku: `P109-B-${tag}`, name: 'Large', priceMinor: 3399, stock: 20, options: [] },
      ],
    })
    const [small, large] = product.variants

    const cart = await buyer.client.adapter.cart.addItem(small!.id, 2)
    buyer.setCartToken(cart.token)
    await buyer.client.adapter.cart.addItem(large!.id, 1)
    const address = addressOf(tag.slice(0, 8))
    const started = await buyer.client.adapter.checkout.create({
      email: buyer.email,
      billingAddress: address,
      shippingAddress: address,
    })
    const paid = await finaliseStubPayment(store.baseUrl, {
      paymentIntentId: started.paymentIntent.id,
      amountMinor: started.paymentIntent.amountMinor,
      currency: started.currency,
    })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)

    // The orders-by-customer view is a projection: wait for it, bounded, instead of sleeping.
    const listed = await vi.waitFor(
      async () => {
        const page = await buyer.client.customer.orders.list()
        expect(page.items.map((o) => o.orderNumber)).toContain(started.orderNumber)
        return page
      },
      { timeout: 5_000, interval: 50 },
    )
    expect(listed.nextCursor === null || typeof listed.nextCursor === 'string').toBe(true)

    const order = await buyer.client.customer.orders.get(started.orderNumber)
    expect(order.orderNumber).toBe(started.orderNumber)
    expect(order.lineItems.length).toBe(2)
    const sumOfLines = order.lineItems.reduce((sum, line) => sum + line.lineTotalMinor, 0)
    expect(sumOfLines).toBe(order.subtotalMinor + order.taxTotalMinor)

    const othersOrders = await other.client.customer.orders.list()
    expect(othersOrders.items.map((o) => o.orderNumber)).not.toContain(started.orderNumber)
  }, 30_000)
})
