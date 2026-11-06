import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'
import { createCheckoutStore } from './checkout-store.js'
import { NymbalApiError } from '../adapter/fetch-client.js'
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

// AC-6: the order's key reaches the page that shows the order. A placed order's key is in the result submitPayment
// resolves to; a refusal that names the order (409 checkout.cart_empty or checkout.payment_in_progress) leaves its
// key in placedOrderKey beside placedOrderNumber, and a refusal with no key leaves none from an earlier answer.
describe('AC-6: CheckoutStore keeps the order key', () => {
  type Answer =
    | { kind: 'placed'; orderNumber: string; orderKey: string | undefined }
    | { kind: 'refused'; code: string; orderNumber: string; orderKey: string | undefined }

  const orderNumber = fc.stringMatching(/^NYM-[0-9]{4}$/)
  const orderKey = fc.option(fc.stringMatching(/^[A-Za-z0-9_-]{43}$/), { nil: undefined })
  const answer: fc.Arbitrary<Answer> = fc.oneof(
    fc.record({ kind: fc.constant('placed' as const), orderNumber, orderKey }),
    fc.record({
      kind: fc.constant('refused' as const),
      code: fc.constantFrom('checkout.cart_empty', 'checkout.payment_in_progress'),
      orderNumber,
      orderKey,
    }),
  )

  it('AC-6: property: over sequences of checkout answers, a placed order resolves with the answer’s orderKey; a 409 naming an order sets placedOrderNumber and placedOrderKey from its context, null when the context has no key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(answer, { minLength: 1, maxLength: 4 }), async (answers) => {
        let next: () => Promise<unknown> = () => Promise.reject(new Error('no answer staged'))
        const adapter = { checkout: { create: () => next() } } as unknown as CommerceAdapter
        const store = createCheckoutStore(adapter)
        store.setEmail('buyer@example.com')
        store.setShippingAddress(addr)
        store.setBillingAddress(addr)

        for (const [i, a] of answers.entries()) {
          const label = `answer ${i} (${a.kind}, ${a.orderKey === undefined ? 'no key' : 'a key'})`
          next =
            a.kind === 'placed'
              ? () =>
                  Promise.resolve({
                    ...orderResult,
                    orderNumber: a.orderNumber,
                    orderStatus: 'confirmed',
                    payment: { status: 'succeeded' },
                    ...(a.orderKey !== undefined && { orderKey: a.orderKey }),
                  })
              : () =>
                  Promise.reject(
                    new NymbalApiError(a.code, `This cart is already order ${a.orderNumber}`, 409, {
                      orderNumber: a.orderNumber,
                      ...(a.orderKey !== undefined && { orderKey: a.orderKey }),
                    }),
                  )
          const result = await store.submitPayment()
          const state = store.getState()
          const seen =
            a.kind === 'placed'
              ? { orderNumber: result?.orderNumber, orderKey: result?.orderKey }
              : {
                  result,
                  placedOrderNumber: state.placedOrderNumber,
                  placedOrderKey: state.placedOrderKey,
                }
          const want =
            a.kind === 'placed'
              ? { orderNumber: a.orderNumber, orderKey: a.orderKey }
              : {
                  result: null,
                  placedOrderNumber: a.orderNumber,
                  placedOrderKey: a.orderKey ?? null,
                }
          expect(seen, label).toStrictEqual(want)
        }
      }),
      { numRuns: 50 },
    )
  })
})

// The element tells an auth refusal from a payment failure by the error's code, so the store keeps it beside the
// message: the code of a NymbalApiError, null for any other error, both cleared by a later submit that succeeds.
describe('the checkout store keeps the code of a refused submit', () => {
  type Answer =
    | { kind: 'api'; code: string; message: string; status: number }
    | { kind: 'error'; message: string }
    | { kind: 'placed' }

  const answer: fc.Arbitrary<Answer> = fc.oneof(
    fc.record({
      kind: fc.constant('api' as const),
      code: fc.constantFrom(
        'auth.token_invalid',
        'checkout.invalid',
        'checkout.payment_in_progress',
        'inventory.insufficient',
      ),
      message: fc.stringMatching(/^[A-Z][a-z ]{0,29}$/),
      status: fc.constantFrom(400, 401, 409, 422),
    }),
    fc.record({
      kind: fc.constant('error' as const),
      message: fc.stringMatching(/^[A-Z][a-z ]{0,29}$/),
    }),
    fc.constant({ kind: 'placed' as const }),
  )

  it('AC-8b: property: over sequences of submits, a NymbalApiError leaves null with error its message and errorCode its code, any other error leaves errorCode null, and a submit that places an order clears both', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(answer, { minLength: 1, maxLength: 6 }), async (answers) => {
        const create = vi.fn()
        const store = createCheckoutStore({ checkout: { create } } as unknown as CommerceAdapter)
        store.setEmail('buyer@example.com')
        store.setShippingAddress(addr)
        store.setBillingAddress(addr)

        for (const a of answers) {
          if (a.kind === 'api') {
            create.mockRejectedValueOnce(new NymbalApiError(a.code, a.message, a.status))
          } else if (a.kind === 'error') {
            create.mockRejectedValueOnce(new TypeError(a.message))
          } else {
            create.mockResolvedValueOnce({ ...orderResult, payment: { status: 'succeeded' } })
          }

          const result = await store.submitPayment()

          const { error, errorCode } = store.getState()
          const placed = a.kind === 'placed'
          expect({ placed: result?.orderNumber ?? null, error, errorCode }, a.kind).toEqual({
            placed: placed ? orderResult.orderNumber : null,
            error: placed ? null : a.message,
            errorCode: a.kind === 'api' ? a.code : null,
          })
        }
      }),
      { numRuns: 50 },
    )
  })
})
