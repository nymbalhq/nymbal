import { useSyncExternalStore } from 'react'
import type { Address, CheckoutQuote } from '@nymbalhq/types'
import type { CheckoutResult, CheckoutState } from '@nymbalhq/sdk'
import { useNymbalClient } from '../context.js'

export interface UseCheckoutReturn extends CheckoutState {
  setEmail: (email: string) => void
  setShippingAddress: (address: Address) => void
  setBillingAddress: (address: Address) => void
  /** Prices the checkout for the shipping address and chosen option; the answer is the state's `quote`. */
  requestQuote: () => Promise<CheckoutQuote | null>
  selectShippingOption: (id: string) => Promise<CheckoutQuote | null>
  submitPayment: () => Promise<CheckoutResult | null>
  markConfirmed: () => void
  reset: () => void
}

export function useCheckout(): UseCheckoutReturn {
  const client = useNymbalClient()
  const state = useSyncExternalStore(
    client.checkout.subscribe,
    client.checkout.getState,
    client.checkout.getState,
  )
  return {
    ...state,
    setEmail: client.checkout.setEmail,
    setShippingAddress: client.checkout.setShippingAddress,
    setBillingAddress: client.checkout.setBillingAddress,
    requestQuote: client.checkout.quote,
    selectShippingOption: client.checkout.selectShippingOption,
    submitPayment: client.checkout.submitPayment,
    markConfirmed: client.checkout.markConfirmed,
    reset: client.checkout.reset,
  }
}
