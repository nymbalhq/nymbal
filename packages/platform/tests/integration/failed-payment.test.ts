import { describe, it, expect } from 'vitest'
import { createTestEnv, testAddr } from './setup.js'

// The platform's checkout flow: beginCheckout creates order + reserves stock + returns paymentIntent.
// The client then confirms payment with Stripe. If client payment fails, finalize() is never called.
// The reservation expires via TTL sweeper and stock is restored.
// This test verifies the stock reservation is held when finalize is not called.
describe('Failed payment flow', () => {
  it('stock stays reserved when finalize is not called after beginCheckout', async () => {
    const env = await createTestEnv()

    const productSnap = await env.product.create({
      slug: 'fail-widget',
      name: 'Fail Widget',
      description: '',
      status: 'active',
      variants: [{ sku: 'FW-F', name: 'Default', priceMinor: 2000, stock: 5, options: [] }],
    })
    const variant = productSnap.variants[0]!

    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 2,
    })

    const started = await env.checkout.beginCheckout({
      cartToken: cart.token, email: 'fail@test.com',
      billingAddress: testAddr, shippingAddress: testAddr,
    })

    // Stock decremented during beginCheckout (reservation)
    const afterReserve = await env.repos.variant.findById(variant.id)
    expect(afterReserve?.stock).toBe(3)

    // Simulating: client payment fails, finalize() is never called.
    // The reservation is still held — stock remains at 3.
    expect(started.paymentIntent.id).toBeTruthy()

    // Verify the reservation exists
    const reservations = await env.repos.inventoryReservation.findByVariant(variant.id)
    expect(reservations.length).toBeGreaterThan(0)

    await env.commandStore.close()
  })

  it('finalize throws if payment intent does not match a pending order', async () => {
    const env = await createTestEnv()
    await expect(
      env.checkout.finalize('pi_nonexistent_intent', 1000),
    ).rejects.toThrow()
    await env.commandStore.close()
  })
})
