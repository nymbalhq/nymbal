import { describe, it, expect } from 'vitest'
import { EVT_ORDER_PAID, EVT_PAYMENT_CAPTURED } from '@nymbal/types'
import { createTestEnv, testAddr } from './setup.js'

// The platform checkout flow:
// 1. beginCheckout() → creates order + reserves stock + returns paymentIntent
// 2. Client confirms payment (Stripe)
// 3. finalize(paymentIntentId, amount) → commits reservation + transitions order to confirmed + emits events
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
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 1,
    })

    const started = await env.checkout.beginCheckout({
      cartToken: cart.token, email: 'webhook@test.com',
      billingAddress: testAddr, shippingAddress: testAddr,
    })

    const eventTypes: string[] = []
    await env.eventBus.subscribe([EVT_ORDER_PAID, EVT_PAYMENT_CAPTURED], (e) => {
      eventTypes.push(e.type)
    })

    const result = await env.checkout.finalize(started.paymentIntent.id, started.totalMinor)
    expect(result.orderNumber).toBeTruthy()

    await new Promise((r) => setTimeout(r, 20))
    expect(eventTypes).toContain(EVT_PAYMENT_CAPTURED)
    expect(eventTypes).toContain(EVT_ORDER_PAID)

    // Order should now be confirmed
    const order = await env.order.getByOrderNumber(result.orderNumber)
    expect(order.status).toBe('confirmed')

    await env.commandStore.close()
  })

  it('finalize throws when called with unknown paymentIntentId', async () => {
    const env = await createTestEnv()
    await expect(
      env.checkout.finalize('pi_unknown_intent', 1000),
    ).rejects.toThrow()
    await env.commandStore.close()
  })

  it('finalize throws when order is already confirmed (prevents double processing)', async () => {
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
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 1,
    })

    const started = await env.checkout.beginCheckout({
      cartToken: cart.token, email: 'dup@test.com',
      billingAddress: testAddr, shippingAddress: testAddr,
    })

    await env.checkout.finalize(started.paymentIntent.id, started.totalMinor)

    // Second finalize should throw (order is no longer pending)
    await expect(
      env.checkout.finalize(started.paymentIntent.id, started.totalMinor),
    ).rejects.toThrow()

    await env.commandStore.close()
  })
})
