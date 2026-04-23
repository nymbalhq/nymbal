import { useSyncExternalStore } from 'react'
import type { Address } from '@nymbal/types'
import type { CheckoutState, ShippingMethod } from '@nymbal/sdk'
import { useNymbalClient } from '../context.js'

export interface UseCheckoutReturn extends CheckoutState {
  setEmail: (email: string) => void
  setShippingAddress: (address: Address) => void
  setBillingAddress: (address: Address) => void
  setShippingMethod: (method: ShippingMethod) => void
  submitPayment: () => Promise<void>
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
    setShippingMethod: client.checkout.setShippingMethod,
    submitPayment: client.checkout.submitPayment,
    reset: client.checkout.reset,
  }
}
