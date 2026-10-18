import { describe, it, expect } from 'vitest'
import { EVT_ORDER_PAID, EVT_PAYMENT_CAPTURED, type NymbalEvent } from '@nymbalhq/types'
import { createTestEnv, testAddr } from './setup.js'

// The platform checkout flow:
// 1. beginCheckout() → creates order + reserves stock + returns paymentIntent
// 2. Client confirms payment (Stripe)
// 3. finalize(paymentIntentId, paid) → commits reservation + transitions order to confirmed + emits events
describe('finalize() — order confirmation flow', () => {
  it('finalize confirms order and emits paid + payment.captured events', async () => {
    const env = await createTestEnv()

    const productSnap = await env.product.create({
      slug: 'webhook-widget',
      name: 'Webhook Widget',
      description: '',
      status: 'active',
      variants: [{ sku: 'WH-1', name: 'Default', priceMinor: 2000, stock: 5, options: [] }],
    })
    const variant = productSnap.variants[0]!

    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id,
      productId: productSnap.id,
      productName: productSnap.name,
      variantName: variant.name,
      priceMinor: variant.priceMinor,
      imageUrl: '',
      qty: 1,
    })

    const started = await env.checkout.beginCheckout({
      cartToken: cart.token,
      email: 'webhook@test.com',
      billingAddress: testAddr,
      shippingAddress: testAddr,
    })

    const eventTypes: string[] = []
    await env.eventBus.subscribe([EVT_ORDER_PAID, EVT_PAYMENT_CAPTURED], (e) => {
      eventTypes.push(e.type)
    })

    const result = await env.checkout.finalize(started.paymentIntent.id, {
      amountMinor: started.totalMinor,
      currency: started.currency,
    })
    expect(result.orderNumber).toBeTruthy()

    await new Promise((r) => setTimeout(r, 20))
    expect(eventTypes).toContain(EVT_PAYMENT_CAPTURED)
    expect(eventTypes).toContain(EVT_ORDER_PAID)

    // Order should now be confirmed
    const order = await env.order.getByOrderNumber(result.orderNumber!)
    expect(order.status).toBe('confirmed')

    await env.commandStore.close()
  })

  // P1-05 decision 4 step 1: an unknown intent is the recorded outcome `no_order`, not a throw Stripe would retry.
  it('AC-6c: finalize for an unknown paymentIntentId is the outcome no_order with no order number', async () => {
    const env = await createTestEnv()
    const result = await env.checkout.finalize('pi_unknown_intent', {
      amountMinor: 1000,
      currency: 'GBP',
    })
    expect(result).toMatchObject({ finalized: false, reason: 'no_order', orderNumber: null })
    await env.commandStore.close()
  })

  // P1-05 decision 5 inverts the old "throws when already confirmed": a second finalize for a confirmed order is the
  // idempotent no-op. Its defect is now a second order.paid, read from the committed event log, not the bus.
  it('AC-6a: a second finalize for an already confirmed order returns the same order number with finalized: true and no second order.paid', async () => {
    const env = await createTestEnv()

    const productSnap = await env.product.create({
      slug: 'double-finalize',
      name: 'Double Finalize',
      description: '',
      status: 'active',
      variants: [{ sku: 'DF-1', name: 'Default', priceMinor: 1500, stock: 5, options: [] }],
    })
    const variant = productSnap.variants[0]!

    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id,
      productId: productSnap.id,
      productName: productSnap.name,
      variantName: variant.name,
      priceMinor: variant.priceMinor,
      imageUrl: '',
      qty: 1,
    })

    const started = await env.checkout.beginCheckout({
      cartToken: cart.token,
      email: 'dup@test.com',
      billingAddress: testAddr,
      shippingAddress: testAddr,
    })
    const paid = { amountMinor: started.totalMinor, currency: started.currency }

    const first = await env.checkout.finalize(started.paymentIntent.id, paid)
    const second = await env.checkout.finalize(started.paymentIntent.id, paid)

    expect(second.orderNumber).toBe(first.orderNumber)
    expect(second.finalized).toBe(true)
    const logged = await env.commandStore.read((tx) => env.repos.eventLog.listAll(tx))
    const paidEvents = logged
      .map((row) => row.event as NymbalEvent<{ orderId: string }>)
      .filter((e) => e.type === EVT_ORDER_PAID && e.payload.orderId === started.orderId)
    expect(paidEvents).toHaveLength(1)
    const stock = await env.commandStore.read((tx) => env.repos.variant.findById(tx, variant.id))
    expect(stock?.stock).toBe(variant.stock - 1)

    await env.commandStore.close()
  })
})
