import type { Address } from '@nymbalhq/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import { NymbalApiError } from '../adapter/fetch-client.js'
import type { CartStore } from './cart-store.js'
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
  placedOrderKey: null,
}

/**
 * The order a refused resubmit names (409 `checkout.cart_empty` or `checkout.payment_in_progress`), if any, and the key
 * the refusal carries to read it.
 */
function namedOrder(err: unknown): Pick<CheckoutState, 'placedOrderNumber' | 'placedOrderKey'> {
  const context = err instanceof NymbalApiError ? err.context : undefined
  const orderNumber = context?.['orderNumber']
  const orderKey = context?.['orderKey']
  return typeof orderNumber === 'string'
    ? {
        placedOrderNumber: orderNumber,
        placedOrderKey: typeof orderKey === 'string' ? orderKey : null,
      }
    : { placedOrderNumber: null, placedOrderKey: null }
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

/**
 * `cart`, when given, is loaded again once the server has answered a submit: placing an order changes the cart on the
 * server (emptied when confirmed, kept while awaiting payment), and whatever renders the cart store must show that.
 */
export function createCheckoutStore(adapter: CommerceAdapter, cart?: CartStore): CheckoutStore {
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
    store.setState({
      paymentStatus: 'processing',
      error: null,
      placedOrderNumber: null,
      placedOrderKey: null,
    })
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
      await cart?.load()
      return result
    } catch (err) {
      const placed = namedOrder(err)
      store.setState({
        paymentStatus: 'failed',
        error: err instanceof Error ? err.message : String(err),
        ...placed,
      })
      // A refusal naming an order: the cart became (or is becoming) that order on the server.
      if (placed.placedOrderNumber !== null) await cart?.load()
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
