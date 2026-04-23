import { describe, it, expect } from 'vitest'
import { createTestEnv } from './setup.js'

describe('Cart merge on login', () => {
  it('merges guest cart items into customer cart on login', async () => {
    const env = await createTestEnv()

    const guestItem = {
      variantId: 'var-guest-1', productId: 'prod-1',
      productName: 'Guest Product', variantName: 'Default',
      priceMinor: 1500, imageUrl: '',
    }
    const custItem = {
      variantId: 'var-cust-1', productId: 'prod-2',
      productName: 'Customer Product', variantName: 'Default',
      priceMinor: 2500, imageUrl: '',
    }

    const guest = await env.cart.getOrCreate()
    await env.cart.addItem(guest.token, guestItem)

    const customerCart = await env.cart.getOrCreate()
    await env.cart.addItem(customerCart.token, custItem)

    const merged = await env.cart.merge(guest.token, customerCart.token)

    // Both items should be in merged cart
    const variantIds = merged.items.map((i) => i.variantId)
    expect(variantIds).toContain('var-guest-1')
    expect(variantIds).toContain('var-cust-1')
    expect(merged.items).toHaveLength(2)
    expect(merged.subtotalMinor).toBe(4000)

    // Guest cart should be deleted
    const guestAfter = await env.cart.get(guest.token)
    expect(guestAfter).toBeNull()

    await env.commandStore.close()
  })

  it('merge with duplicate variant takes max qty from guest', async () => {
    const env = await createTestEnv()

    const sharedItem = {
      variantId: 'shared-var', productId: 'prod-3',
      productName: 'Shared Product', variantName: 'Default',
      priceMinor: 1000, imageUrl: '',
    }

    const guest = await env.cart.getOrCreate()
    await env.cart.addItem(guest.token, { ...sharedItem, qty: 5 })

    const customer = await env.cart.getOrCreate()
    await env.cart.addItem(customer.token, { ...sharedItem, qty: 2 })

    const merged = await env.cart.merge(guest.token, customer.token)

    // Should take max qty = 5
    expect(merged.items[0]!.qty).toBe(5)
    expect(merged.items).toHaveLength(1)

    await env.commandStore.close()
  })

  it('merge when guest cart is empty returns customer cart unchanged', async () => {
    const env = await createTestEnv()

    const customer = await env.cart.getOrCreate()
    await env.cart.addItem(customer.token, {
      variantId: 'var-only', productId: 'prod-4',
      productName: 'Only', variantName: 'D', priceMinor: 800, imageUrl: '',
    })

    const merged = await env.cart.merge('nonexistent-guest', customer.token)
    expect(merged.token).toBe(customer.token)
    expect(merged.items).toHaveLength(1)

    await env.commandStore.close()
  })
})
