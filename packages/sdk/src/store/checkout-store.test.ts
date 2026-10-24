import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'
import { createCheckoutStore } from './checkout-store.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { Address } from '@nymbalhq/types'

const addr: Address = {
  firstName: 'Jane',
  lastName: 'Doe',
  addressLine1: '1 Test St',
  city: 'London',
  region: 'England',
  postalCode: 'SW1A 1AA',
  country: 'GB',
}

const orderResult = {
  orderId: 'ord-1',
  orderNumber: 'ORD-001',
  paymentIntent: {
    id: 'pi_1',
    clientSecret: 'secret',
    amountMinor: 1000,
    currency: 'GBP',
    status: 'requires_payment_method' as const,
  },
  totalMinor: 1000,
  currency: 'GBP',
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
    store.setShippingMethod({
      carrier: 'Royal Mail',
      service: 'Standard',
      amountMinor: 0,
      currency: 'GBP',
      estimatedDays: 3,
    })
    expect(store.getState().step).toBe('payment')
  })

  it('submitPayment without addresses sets error', async () => {
    const store = createCheckoutStore(makeAdapter())
    await store.submitPayment()
    expect(store.getState().error).toBeTruthy()
    expect(store.getState().paymentStatus).toBe('idle')
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

// AC-5: `paymentStatus` is what the server said about the payment, not "the order was created"; `submitPayment()`
// resolves to the server's checkout result (null when there is none); a template calls `markConfirmed()` once
// Stripe's confirmation succeeds.
describe('AC-5: CheckoutStore follows the server payment status', () => {
  type ServerStatus = 'succeeded' | 'requires_action' | 'failed'

  function serverResult(status: ServerStatus, orderNumber = 'NYM-5001') {
    return {
      orderId: `ord-${orderNumber}`,
      orderNumber,
      paymentIntent: {
        id: `pi_${orderNumber}`,
        clientSecret: `pi_${orderNumber}_secret`,
        amountMinor: 4200,
        currency: 'GBP',
        status: status === 'requires_action' ? ('requires_payment_method' as const) : status,
      },
      currency: 'GBP',
      totalMinor: 4200,
      orderStatus:
        status === 'succeeded' ? 'confirmed' : status === 'failed' ? 'cancelled' : 'pending',
      payment: status === 'failed' ? { status, reason: 'stub_declined' } : { status },
    }
  }

  function readyStore(result: unknown) {
    const adapter = {
      checkout: { create: vi.fn().mockResolvedValue(result) },
    } as unknown as CommerceAdapter
    const store = createCheckoutStore(adapter)
    store.setEmail('buyer@example.com')
    store.setShippingAddress(addr)
    store.setBillingAddress(addr)
    return store
  }

  it('AC-5: for any server payment status, paymentStatus after submitPayment is that status and submitPayment resolves to the server result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ServerStatus>('succeeded', 'requires_action', 'failed'),
        fc.stringMatching(/^NYM-[0-9]{4}$/),
        async (status, orderNumber) => {
          const result = serverResult(status, orderNumber)
          const store = readyStore(result)
          const resolved = await store.submitPayment()
          expect(store.getState().paymentStatus).toBe(result.payment.status)
          expect(resolved).toEqual(result)
          expect(store.getState().order?.orderNumber).toBe(result.orderNumber)
        },
      ),
      { numRuns: 30 },
    )
  })

  it('AC-5: a Stripe checkout (requires_action) is not succeeded until markConfirmed, then it is', async () => {
    const store = readyStore(serverResult('requires_action'))
    await store.submitPayment()
    const beforeConfirm = store.getState().paymentStatus
    expect(beforeConfirm).toBe('requires_action')

    store.markConfirmed()

    expect(store.getState().paymentStatus).toBe('succeeded')
    expect(store.getState().paymentStatus).not.toBe(beforeConfirm)
  })

  it('AC-5: submitPayment resolves to null when there is no result: addresses missing, or the request rejected', async () => {
    const missing = createCheckoutStore(makeAdapter())
    const rejecting = makeAdapter()
    vi.mocked(rejecting.checkout.create).mockRejectedValueOnce(new Error('network down'))
    const rejected = createCheckoutStore(rejecting)
    rejected.setShippingAddress(addr)
    rejected.setBillingAddress(addr)

    expect(await missing.submitPayment()).toBeNull()
    expect(await rejected.submitPayment()).toBeNull()
    expect(rejected.getState().paymentStatus).toBe('failed')
  })
})
