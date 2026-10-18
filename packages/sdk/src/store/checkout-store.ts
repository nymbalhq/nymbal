import type { Address } from '@nymbalhq/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import { NymbalApiError } from '../adapter/fetch-client.js'
import type { CheckoutResult, CheckoutState, ShippingMethod } from '../types.js'
import { createStore } from './create-store.js'

const INITIAL_STATE: CheckoutState = {
  step: 'contact',
  email: '',
  shippingAddress: null,
  billingAddress: null,
  shippingMethod: null,
  paymentStatus: 'idle',
  error: null,
  order: null,
  placedOrderNumber: null,
}

/** The order a refused resubmit names (409 `checkout.cart_empty` or `checkout.payment_in_progress`), if any. */
function namedOrder(err: unknown): string | null {
  if (!(err instanceof NymbalApiError)) return null
  const orderNumber = err.context?.['orderNumber']
  return typeof orderNumber === 'string' ? orderNumber : null
}

export interface CheckoutStore {
  getState(): CheckoutState
  subscribe(listener: () => void): () => void
  setEmail(email: string): void
  setShippingAddress(address: Address): void
  setBillingAddress(address: Address): void
  setShippingMethod(method: ShippingMethod): void
  /** Places the order; resolves to the server's result, or null when there is none. */
  submitPayment(): Promise<CheckoutResult | null>
  /** The provider confirmed the payment on the client (Stripe's `confirmCardPayment`). */
  markConfirmed(): void
  reset(): void
  destroy(): void
}

export function createCheckoutStore(adapter: CommerceAdapter): CheckoutStore {
  const store = createStore<CheckoutState>(INITIAL_STATE)

  function setEmail(email: string): void {
    store.setState({ email, step: 'shipping' })
  }

  function setShippingAddress(address: Address): void {
    store.setState({ shippingAddress: address })
  }

  function setBillingAddress(address: Address): void {
    store.setState({ billingAddress: address })
  }

  function setShippingMethod(method: ShippingMethod): void {
    store.setState({ shippingMethod: method, step: 'payment' })
  }

  async function submitPayment(): Promise<CheckoutResult | null> {
    const state = store.getState()
    if (!state.shippingAddress || !state.billingAddress) {
      store.setState({ error: 'Shipping and billing addresses are required' })
      return null
    }
    store.setState({ paymentStatus: 'processing', error: null, placedOrderNumber: null })
    try {
      const result = await adapter.checkout.create({
        email: state.email,
        billingAddress: state.billingAddress,
        shippingAddress: state.shippingAddress,
      })
      const { status, reason } = result.payment
      store.setState({
        paymentStatus: status,
        order: {
          orderId: result.orderId,
          orderNumber: result.orderNumber,
          paymentIntent: result.paymentIntent,
        },
        error:
          status === 'failed'
            ? `Your payment did not go through${reason ? ` (${reason})` : ''}. Please try again.`
            : null,
        ...(status === 'succeeded' && { step: 'confirmation' as const }),
      })
      return result
    } catch (err) {
      store.setState({
        paymentStatus: 'failed',
        error: err instanceof Error ? err.message : String(err),
        placedOrderNumber: namedOrder(err),
      })
      return null
    }
  }

  function markConfirmed(): void {
    store.setState({ paymentStatus: 'succeeded', step: 'confirmation' })
  }

  function reset(): void {
    store.setState(INITIAL_STATE)
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    setEmail,
    setShippingAddress,
    setBillingAddress,
    setShippingMethod,
    submitPayment,
    markConfirmed,
    reset,
    destroy: store.destroy,
  }
}
