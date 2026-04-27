import { describe, it, expect } from 'vitest'
import {
  CheckoutError,
  EVT_ORDER_PLACED,
  EVT_ORDER_PAID,
  EVT_PAYMENT_CAPTURED,
  EVT_CART_CONVERTED,
} from '@nymbal/types'
import { registerOrderProjection } from '../../src/handlers/projections/order-projection.js'
import { createLogger } from '../../src/logger.js'
import { createTestEnv, testAddr } from './setup.js'

describe('Full order flow: cart → checkout → payment → order', () => {
  it('complete purchase flow: order created, stock decremented, cart cleared, read model populated', async () => {
    const env = await createTestEnv()
    const logger = createLogger({ pretty: false, level: 'error' })

    await registerOrderProjection({
      eventBus: env.eventBus,
      documentStore: env.documentStore,
      logger,
      orderRepo: env.repos.order,
      orderHistoryRepo: env.repos.orderHistory,
    })

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

    // Order number has the expected prefix
    const draftOrder = await env.repos.order.findById(started.orderId)
    expect(draftOrder?.orderNumber).toMatch(/^INT-/)

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

    // Order exists in document store read model
    const orderNumber = draftOrder!.orderNumber
    const readModel = await env.documentStore.get<{ orderNumber: string; status: string }>('orders', orderNumber)
    expect(readModel).toBeDefined()
    expect(readModel!.orderNumber).toBe(orderNumber)
    expect(readModel!.status).toBe('confirmed')

    await env.commandStore.close()
  })

  it('insufficient stock: CheckoutError thrown, no order created, inventory unchanged', async () => {
    const env = await createTestEnv()

    const productSnap = await env.product.create({
      slug: 'scarce-widget',
      name: 'Scarce Widget',
      status: 'active',
      variants: [{ sku: 'SW-1', name: 'Default', priceMinor: 1000, stock: 1, lowStockThreshold: 0, options: [] }],
    })
    const variant = productSnap.variants[0]!

    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 2,
    })

    await expect(
      env.checkout.beginCheckout({
        cartToken: cart.token, email: 'buyer@test.com',
        billingAddress: testAddr, shippingAddress: testAddr,
      }),
    ).rejects.toThrow(CheckoutError)

    // No order created
    const orders = await env.repos.order.list({ limit: 100 })
    expect(orders).toHaveLength(0)

    // Stock unchanged
    const stockAfter = await env.repos.variant.findById(variant.id)
    expect(stockAfter?.stock).toBe(1)

    // No reservations
    const reservations = await env.repos.inventoryReservation.findByVariant(variant.id)
    expect(reservations).toHaveLength(0)

    await env.commandStore.close()
  })

  it('payment failure (cancel path): reservations released, stock restored, cart preserved', async () => {
    const env = await createTestEnv()

    const productSnap = await env.product.create({
      slug: 'cancel-widget',
      name: 'Cancel Widget',
      status: 'active',
      variants: [{ sku: 'CW-1', name: 'Default', priceMinor: 2000, stock: 10, lowStockThreshold: 2, options: [] }],
    })
    const variant = productSnap.variants[0]!

    const cart = await env.cart.getOrCreate()
    await env.cart.addItem(cart.token, {
      variantId: variant.id, productId: productSnap.id,
      productName: productSnap.name, variantName: variant.name,
      priceMinor: variant.priceMinor, imageUrl: '', qty: 2,
    })

    const started = await env.checkout.beginCheckout({
      cartToken: cart.token, email: 'buyer@test.com',
      billingAddress: testAddr, shippingAddress: testAddr,
    })

    // Stock reserved (10 - 2 = 8)
    const afterReserve = await env.repos.variant.findById(variant.id)
    expect(afterReserve?.stock).toBe(8)

    // Simulate payment failure: operator/webhook calls cancel
    await env.checkout.cancel(started.orderId, 'payment_failed')

    // Reservations released — stock restored
    const reservations = await env.repos.inventoryReservation.findByVariant(variant.id)
    expect(reservations).toHaveLength(0)

    const stockAfter = await env.repos.variant.findById(variant.id)
    expect(stockAfter?.stock).toBe(10)

    // Cart still has its items (cancel does not touch the cart)
    const cartAfter = await env.cart.get(cart.token)
    expect(cartAfter?.items).toHaveLength(1)

    // Order exists but is cancelled
    const order = await env.repos.order.findById(started.orderId)
    expect(order?.status).toBe('cancelled')

    await env.commandStore.close()
  })
})
