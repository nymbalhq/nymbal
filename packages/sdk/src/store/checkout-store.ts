import type { Address } from '@nymbal/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { CheckoutState, ShippingMethod } from '../types.js'
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
}

export interface CheckoutStore {
  getState(): CheckoutState
  subscribe(listener: () => void): () => void
  setEmail(email: string): void
  setShippingAddress(address: Address): void
  setBillingAddress(address: Address): void
  setShippingMethod(method: ShippingMethod): void
  submitPayment(): Promise<void>
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

  async function submitPayment(): Promise<void> {
    const state = store.getState()
    if (!state.shippingAddress || !state.billingAddress) {
      store.setState({ error: 'Shipping and billing addresses are required' })
      return
    }
    store.setState({ paymentStatus: 'processing', error: null })
    try {
      const result = await adapter.checkout.create({
        email: state.email,
        billingAddress: state.billingAddress,
        shippingAddress: state.shippingAddress,
      })
      store.setState({
        paymentStatus: 'succeeded',
        order: { orderId: result.orderId, orderNumber: result.orderNumber, paymentIntent: result.paymentIntent },
        step: 'confirmation',
      })
    } catch (err) {
      store.setState({
        paymentStatus: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
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
    reset,
    destroy: store.destroy,
  }
}
