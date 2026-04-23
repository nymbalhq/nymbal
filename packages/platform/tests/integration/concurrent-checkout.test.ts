import { describe, it, expect } from 'vitest'
import { AdapterError } from '@nymbal/types'
import { createTestEnv, testAddr } from './setup.js'

// Note: The SQLite CommandStore in test mode uses a simplified transaction wrapper
// that doesn't enforce serializable isolation across async boundaries.
// This test validates the stock validation logic sequentially (which is the correct
// behavior in production where requests are serialized).
describe('Inventory stock validation during checkout', () => {
  it('first checkout succeeds and second checkout fails when only 1 unit available', async () => {
    const env = await createTestEnv()

    const productSnap = await env.product.create({
      slug: 'last-unit',
      name: 'Last Unit Widget',
      description: '',
      status: 'active',
      variants: [{ sku: 'LU-1', name: 'Default', priceMinor: 1000, stock: 1, options: [] }],
    })
    const variant = productSnap.variants[0]!

    const cartA = await env.cart.getOrCreate()
    await env.cart.addItem(cartA.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 1,
    })

    const cartB = await env.cart.getOrCreate()
    await env.cart.addItem(cartB.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 1,
    })

    // First checkout succeeds
    const first = await env.checkout.beginCheckout({
      cartToken: cartA.token, email: 'buyer-a@test.com',
      billingAddress: testAddr, shippingAddress: testAddr,
    })
    expect(first.paymentIntent.id).toBeTruthy()

    // Stock should be 0 now (reserved by first checkout)
    const afterFirst = await env.repos.variant.findById(variant.id)
    expect(afterFirst?.stock).toBe(0)

    // Second checkout should fail because stock is 0
    await expect(env.checkout.beginCheckout({
      cartToken: cartB.token, email: 'buyer-b@test.com',
      billingAddress: testAddr, shippingAddress: testAddr,
    })).rejects.toThrow()

    await env.commandStore.close()
  })

  it('reserveStock throws AdapterError for insufficient stock', async () => {
    const env = await createTestEnv()
    const productSnap = await env.product.create({
      slug: 'low-stock',
      name: 'Low Stock',
      description: '',
      status: 'active',
      variants: [{ sku: 'LS-1', name: 'Default', priceMinor: 500, stock: 2, options: [] }],
    })
    const variant = productSnap.variants[0]!

    // Try to reserve more than available
    await expect(
      env.inventory.reserveStock(variant.id, 5),
    ).rejects.toThrow(AdapterError)

    await env.commandStore.close()
  })
})
