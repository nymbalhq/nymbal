import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finaliseStubPayment } from '@nymbalhq/proof-kit/payments'
import { startTestStore, type TestStore } from '@nymbalhq/proof-kit/store'
import { EVT_ORDER_PAID } from '@nymbalhq/types'

// AC-12: finaliseStubPayment goes through the real POST /api/webhooks/stripe route of a store started by
// startTestStore(): the order is confirmed and its reservation committed, and the same eventId again is deduped by
// the route, so order.paid.v1 is published once.

const address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

let store: TestStore

beforeAll(async () => {
  store = await startTestStore()
}, 30_000)

afterAll(async () => {
  await store?.stop()
})

describe('AC-12: finaliseStubPayment through the real webhook route', () => {
  it('AC-12: a fresh eventId confirms the order and commits its reservation; the same eventId again is deduped and order.paid.v1 is published once', async () => {
    const { services, repos, platform } = store.app
    const initialStock = 5
    const qty = 2
    const product = await services.product.create({
      slug: `paid-${randomUUID()}`,
      name: 'Paid Widget',
      description: '',
      status: 'active',
      variants: [
        {
          sku: `PAID-${randomUUID()}`,
          name: 'Default',
          priceMinor: 1250,
          stock: initialStock,
          options: [],
        },
      ],
    })
    const variant = product.variants[0]!
    const cart = await services.cart.getOrCreate()
    await services.cart.addItem(cart.token, {
      variantId: variant.id,
      productId: product.id,
      productName: product.name,
      variantName: variant.name,
      priceMinor: variant.priceMinor,
      imageUrl: '',
      qty,
    })
    const started = await services.checkout.beginCheckout({
      cartToken: cart.token,
      // `+stub-pending`: pending with its reservation until the hook below pays it.
      email: `paid-${randomUUID()}+stub-pending@proof-kit.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    const reservedBefore = await platform.commandStore.read((tx) =>
      repos.inventoryReservation.findByVariant(tx, variant.id),
    )

    const paid: string[] = []
    await platform.eventBus.subscribe(EVT_ORDER_PAID, (event) => {
      paid.push(event.id)
    })

    const hook = {
      paymentIntentId: started.paymentIntent.id,
      amountMinor: started.totalMinor,
      currency: started.currency,
      eventId: `evt_${randomUUID()}`,
    }
    const first = await finaliseStubPayment(store.baseUrl, hook)

    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const order = await services.order.getByOrderNumber(started.orderNumber)
    expect(order.status).toBe('confirmed')
    expect(reservedBefore).toHaveLength(1)
    expect(
      await platform.commandStore.read((tx) =>
        repos.inventoryReservation.findByVariant(tx, variant.id),
      ),
    ).toHaveLength(0)
    expect(
      (await platform.commandStore.read((tx) => repos.variant.findById(tx, variant.id)))?.stock,
    ).toBe(initialStock - qty)
    expect(paid).toHaveLength(1)

    const again = await finaliseStubPayment(store.baseUrl, hook)

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body).toEqual({ data: { deduped: true } })
    expect(paid).toHaveLength(1)
    expect((await services.order.getByOrderNumber(started.orderNumber)).status).toBe('confirmed')
  }, 30_000)
})
