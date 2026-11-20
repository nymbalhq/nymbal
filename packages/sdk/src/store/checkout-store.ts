import type { Address, CheckoutQuote } from '@nymbalhq/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import { NymbalApiError } from '../adapter/fetch-client.js'
import type { CartStore } from './cart-store.js'
import type { CheckoutResult, CheckoutState } from '../types.js'
import { createStore } from './create-store.js'

const INITIAL_STATE: CheckoutState = {
  step: 'contact',
  email: '',
  shippingAddress: null,
  billingAddress: null,
  quote: null,
  quoting: false,
  paymentStatus: 'idle',
  error: null,
  errorCode: null,
  order: null,
  placedOrderNumber: null,
  placedOrderKey: null,
}

const QUOTE_PENDING =
  'Your total is still being worked out. Please wait a moment, then place your order.'
const NO_QUOTE = 'Your total has not been worked out yet. Please continue from the shipping step.'

/** Refusals at Place Order that mean the total moved: the store quotes again, so the shopper sees the new one. */
const REQUOTE = new Set(['checkout.total_changed', 'checkout.shipping_option_unavailable'])

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
  /**
   * Prices the checkout for the stored shipping address and the option chosen, if any; null when it is refused (the
   * state's `errorCode` says why). Only the answer to the latest request is kept in the state.
   */
  quote(): Promise<CheckoutQuote | null>
  /**
   * Chooses a delivery option and quotes for it. A refusal keeps the last quote and its option in the state (the
   * `errorCode` says why), so what is shown and sent stays a total the server gave.
   */
  selectShippingOption(id: string): Promise<CheckoutQuote | null>
  /**
   * Places the order at the quote's option and total; resolves to the server's result, or null when there is none.
   * With no quote, or one in flight, nothing is sent, unless the last quote was refused because the cart already
   * became an order: that order's own refusal then names it.
   */
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

  /** The option the shopper chose; absent, the server's first for the address. */
  let chosen: string | undefined
  /** Numbers each quote request, so only the latest answer reaches the state. */
  let latest = 0
  let inFlight = 0
  /** The last quote was refused `checkout.cart_empty`: the cart already became an order. */
  let cartBecameOrder = false

  function quote(): Promise<CheckoutQuote | null> {
    return ask(false)
  }

  async function ask(keepOnRefusal: boolean): Promise<CheckoutQuote | null> {
    const { shippingAddress, email } = store.getState()
    if (!shippingAddress) {
      store.setState({ error: 'A shipping address is required', errorCode: null })
      return null
    }
    const ticket = ++latest
    inFlight += 1
    store.setState({ quoting: true })
    try {
      const answer = await adapter.checkout.quote({
        shippingAddress,
        ...(chosen !== undefined && { shippingOptionId: chosen }),
        ...(email !== '' && { email }),
      })
      if (ticket === latest) {
        cartBecameOrder = false
        store.setState({ quote: answer })
      }
      return answer
    } catch (err) {
      if (ticket === latest) {
        const code = err instanceof NymbalApiError ? err.code : null
        const kept = keepOnRefusal ? store.getState().quote : null
        if (keepOnRefusal) chosen = kept?.shippingOptionId
        // The server does not offer that option here: the next quote takes the address's first.
        else if (code === 'checkout.shipping_option_unavailable') chosen = undefined
        cartBecameOrder = code === 'checkout.cart_empty'
        store.setState({
          quote: kept,
          error: err instanceof Error ? err.message : String(err),
          errorCode: code,
        })
      }
      return null
    } finally {
      inFlight -= 1
      store.setState({ quoting: inFlight > 0 })
    }
  }

  function selectShippingOption(id: string): Promise<CheckoutQuote | null> {
    chosen = id
    return ask(true)
  }

  async function submitPayment(): Promise<CheckoutResult | null> {
    const state = store.getState()
    if (!state.shippingAddress || !state.billingAddress) {
      store.setState({ error: 'Shipping and billing addresses are required', errorCode: null })
      return null
    }
    if (state.quoting) {
      store.setState({ error: QUOTE_PENDING, errorCode: null })
      return null
    }
    const shown = state.quote
    if (shown === null && !cartBecameOrder) {
      store.setState({ error: NO_QUOTE, errorCode: null })
      return null
    }
    store.setState({
      paymentStatus: 'processing',
      error: null,
      errorCode: null,
      placedOrderNumber: null,
      placedOrderKey: null,
    })
    try {
      const result = await adapter.checkout.create({
        email: state.email,
        billingAddress: state.billingAddress,
        shippingAddress: state.shippingAddress,
        ...(shown !== null && {
          shippingOptionId: shown.shippingOptionId,
          expectedTotalMinor: shown.totals.totalMinor,
        }),
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
      const refused = {
        error: err instanceof Error ? err.message : String(err),
        errorCode: err instanceof NymbalApiError ? err.code : null,
      }
      store.setState({ paymentStatus: 'failed', ...refused, ...placed })
      // A refusal naming an order: the cart became (or is becoming) that order on the server.
      if (placed.placedOrderNumber !== null) await cart?.load()
      // The total moved: quote once more so the shopper is shown the new one; never place again unasked.
      if (refused.errorCode !== null && REQUOTE.has(refused.errorCode)) {
        if (refused.errorCode === 'checkout.shipping_option_unavailable') chosen = undefined
        await quote()
        store.setState(refused)
      }
      return null
    }
  }

  function markConfirmed(): void {
    store.setState({ paymentStatus: 'succeeded', step: 'confirmation' })
  }

  function reset(): void {
    chosen = undefined
    cartBecameOrder = false
    // An answer still in flight belongs to the checkout being left.
    latest += 1
    store.setState({ ...INITIAL_STATE, quoting: inFlight > 0 })
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    setEmail,
    setShippingAddress,
    setBillingAddress,
    quote,
    selectShippingOption,
    submitPayment,
    markConfirmed,
    reset,
    destroy: store.destroy,
  }
}
