import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { CheckoutState, NymbalClient } from '@nymbalhq/sdk'
import { NymbalProvider } from '../context.js'
import { useCheckout } from './use-checkout.js'

// useCheckout over a checkout store of the test's own that keeps state as the SDK's does: choosing a delivery option
// through the hook reaches the store, and the hook re-renders with what the store then holds.

const quoteOf = (optionId: string) => ({
  currency: 'GBP',
  options: [
    { id: 'standard', name: 'Standard', amountMinor: 0, estimatedDays: 3 },
    { id: 'express', name: 'Express', amountMinor: 499, estimatedDays: 1 },
  ],
  shippingOptionId: optionId,
  totals: { totalMinor: optionId === 'express' ? 2_999 : 2_500 },
})

function checkoutStore() {
  let state = {
    step: 'payment',
    quote: quoteOf('standard'),
    quoting: false,
  } as unknown as CheckoutState
  const listeners = new Set<() => void>()
  const set = (partial: Record<string, unknown>) => {
    state = { ...state, ...partial } as CheckoutState
    for (const l of listeners) l()
  }
  let release: () => void = () => undefined
  return {
    getState: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** Answers once the test releases it, so the in-flight state can be read. */
    async selectShippingOption(id: string) {
      set({ quoting: true })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      set({ quoting: false, quote: quoteOf(id) })
      return quoteOf(id)
    },
    async quote() {
      return (state as unknown as { quote: unknown }).quote
    },
    release: () => release(),
  }
}

function wrapperOf(client: NymbalClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <NymbalProvider client={client}>{children}</NymbalProvider>
  }
}

describe('AC-13: useCheckout and the delivery option', () => {
  // Kills: the hook still handing out setShippingMethod, a method the server never read, instead of the call that
  // re-quotes the order for the option the shopper picked.
  it('AC-13: selectShippingOption from the hook re-quotes through the store and the hook re-renders with quoting while it is in flight and the new quote after; setShippingMethod is gone', async () => {
    const store = checkoutStore()
    const client = { checkout: store } as unknown as NymbalClient
    const { result } = renderHook(() => useCheckout(), { wrapper: wrapperOf(client) })

    let pending: Promise<unknown> = Promise.resolve()
    act(() => {
      pending = result.current.selectShippingOption('express')
    })
    expect(result.current.quoting).toBe(true)
    const during = result.current.quoting
    await act(async () => {
      store.release()
      await pending
    })

    expect(result.current.quoting).toBe(false)
    expect(result.current.quoting).not.toBe(during)
    expect(result.current.quoting).toBe(store.getState().quoting)
    expect(
      (store.getState() as unknown as { quote: { shippingOptionId: string } }).quote
        .shippingOptionId,
    ).toBe('express')
    expect('setShippingMethod' in result.current).toBe(false)
  })
})
