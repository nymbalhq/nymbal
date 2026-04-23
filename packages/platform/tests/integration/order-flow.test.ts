import { describe, it, expect } from 'vitest'
import { EVT_ORDER_PLACED, EVT_ORDER_PAID, EVT_PAYMENT_CAPTURED, EVT_CART_CONVERTED } from '@nymbal/types'
import { createTestEnv, testAddr } from './setup.js'

describe('Full order flow: cart → checkout → payment → order', () => {
  it('complete purchase flow decrements stock and emits all expected events', async () => {
    const env = await createTestEnv()

    const productSnap = await env.product.create({
      slug: 'flow-widget',
      name: 'Flow Widget',
      description: '',
      status: 'active',
      variants: [{ sku: 'FW-1', name: 'Default', priceMinor: 3000, stock: 10, lowStockThreshold: 2, options: [] }],
    })
    const variant = productSnap.variants[0]!

    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 2,
    })

    const eventTypes: string[] = []
    await env.eventBus.subscribe(
      [EVT_ORDER_PLACED, EVT_ORDER_PAID, EVT_PAYMENT_CAPTURED, EVT_CART_CONVERTED],
      (e) => { eventTypes.push(e.type) },
    )

    const started = await env.checkout.beginCheckout({
      cartToken: cart.token, email: 'buyer@test.com',
      billingAddress: testAddr, shippingAddress: testAddr,
    })

    expect(started.totalMinor).toBe(6000)

    // Stock was reserved during checkout
    const afterReserve = await env.repos.variant.findById(variant.id)
    expect(afterReserve?.stock).toBe(8)

    await env.checkout.finalize(started.paymentIntent.id, started.totalMinor)

    // Cart should be cleared
    const clearedCart = await env.cart.get(cart.token)
    expect(clearedCart?.items).toHaveLength(0)

    // All expected events fired
    await new Promise((r) => setTimeout(r, 20))
    expect(eventTypes).toContain(EVT_ORDER_PLACED)
    expect(eventTypes).toContain(EVT_ORDER_PAID)
    expect(eventTypes).toContain(EVT_PAYMENT_CAPTURED)
    expect(eventTypes).toContain(EVT_CART_CONVERTED)

    // Reservation committed — removed from reservation table
    const reservations = await env.repos.inventoryReservation.findByVariant(variant.id)
    expect(reservations).toHaveLength(0)

    await env.commandStore.close()
  })
})
