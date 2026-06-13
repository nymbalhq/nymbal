import { describe, it, expect, vi } from 'vitest'
import { createCheckoutStore } from './checkout-store.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { Address } from '@nymbal/types'

const addr: Address = {
  firstName: 'Jane', lastName: 'Doe',
  addressLine1: '1 Test St', city: 'London',
  region: 'England', postalCode: 'SW1A 1AA', country: 'GB',
}

const orderResult = {
  orderId: 'ord-1', orderNumber: 'ORD-001',
  paymentIntent: { id: 'pi_1', clientSecret: 'secret', amountMinor: 1000, currency: 'GBP', status: 'requires_payment_method' as const },
  totalMinor: 1000, currency: 'GBP',
}

function makeAdapter(): CommerceAdapter {
  return {
    checkout: {
      create: vi.fn().mockResolvedValue(orderResult),
    },
  } as unknown as CommerceAdapter
}

describe('CheckoutStore', () => {
  it('initial step is contact', () => {
    const store = createCheckoutStore(makeAdapter())
    expect(store.getState().step).toBe('contact')
  })

  it('setEmail advances step to shipping', () => {
    const store = createCheckoutStore(makeAdapter())
    store.setEmail('user@example.com')
    expect(store.getState().email).toBe('user@example.com')
    expect(store.getState().step).toBe('shipping')
  })

  it('setShippingAddress stores address', () => {
    const store = createCheckoutStore(makeAdapter())
    store.setShippingAddress(addr)
    expect(store.getState().shippingAddress).toEqual(addr)
  })

  it('setBillingAddress stores address', () => {
    const store = createCheckoutStore(makeAdapter())
    store.setBillingAddress(addr)
    expect(store.getState().billingAddress).toEqual(addr)
  })

  it('setShippingMethod advances step to payment', () => {
    const store = createCheckoutStore(makeAdapter())
    store.setShippingMethod({ carrier: 'Royal Mail', service: 'Standard', amountMinor: 0, currency: 'GBP', estimatedDays: 3 })
    expect(store.getState().step).toBe('payment')
  })

  it('submitPayment without addresses sets error', async () => {
    const store = createCheckoutStore(makeAdapter())
    await store.submitPayment()
    expect(store.getState().error).toBeTruthy()
    expect(store.getState().paymentStatus).toBe('idle')
  })

  it('submitPayment calls adapter.checkout.create when addresses set', async () => {
    const adapter = makeAdapter()
    const store = createCheckoutStore(adapter)
    store.setEmail('buyer@example.com')
    store.setShippingAddress(addr)
    store.setBillingAddress(addr)
    await store.submitPayment()
    expect(adapter.checkout.create).toHaveBeenCalled()
    expect(store.getState().paymentStatus).toBe('succeeded')
    expect(store.getState().order).toBeTruthy()
  })

  it('submitPayment on failure sets paymentStatus failed', async () => {
    const adapter = makeAdapter()
    vi.mocked(adapter.checkout.create).mockRejectedValueOnce(new Error('card declined'))
    const store = createCheckoutStore(adapter)
    store.setShippingAddress(addr)
    store.setBillingAddress(addr)
    await store.submitPayment()
    expect(store.getState().paymentStatus).toBe('failed')
    expect(store.getState().error).toBe('card declined')
  })

  it('reset returns to initial state', async () => {
    const store = createCheckoutStore(makeAdapter())
    store.setEmail('buyer@test.com')
    store.setShippingAddress(addr)
    store.reset()
    expect(store.getState().step).toBe('contact')
    expect(store.getState().email).toBe('')
    expect(store.getState().shippingAddress).toBeNull()
  })
})
