import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  createCartStore,
  NymbalApiError,
  type CommerceAdapter,
  type NymbalClient,
} from '@nymbalhq/sdk'
import type { CartCodeStatus, ShopperCart } from '@nymbalhq/types'
import { NymbalProvider } from '../context.js'
import { useCart } from './use-cart.js'

// `useCart()` over a real cart store on an adapter of the test's own: a React storefront reaches the code calls and
// re-renders with the totals and codes each answer carries.

const LINE = {
  variantId: 'v-lamp',
  productId: 'p-lamp',
  productName: 'Lamp',
  variantName: '',
  priceMinor: 2_400,
  qty: 2,
  imageUrl: '',
}

/** The cart answer for these codes: each 10% code accepted moves a tenth of the subtotal. */
function answerFor(codes: string[]): ShopperCart {
  const subtotalMinor = LINE.priceMinor * LINE.qty
  const discountTotalMinor = codes.length === 0 ? 0 : Math.floor(subtotalMinor / 10)
  return {
    token: 'cart-hook',
    customerId: null,
    items: [LINE],
    subtotalMinor,
    currency: 'GBP',
    source: 'storefront',
    expiresAt: '2026-12-21T00:00:00.000Z',
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
    totals: {
      currency: 'GBP',
      subtotalMinor,
      discountTotalMinor,
      shippingTotalMinor: 0,
      shippingDiscountMinor: 0,
      taxTotalMinor: 0,
      totalMinor: subtotalMinor - discountTotalMinor,
      pricesIncludeTax: false,
      lines: [],
      applied: [],
    },
    promotions: {
      codes: codes.map((code): CartCodeStatus => ({ code, status: 'accepted' })),
      unavailable: false,
    },
  }
}

/** A cart of one line whose code calls answer as the API does, and refuse with `refuseNext` once when it is set. */
function stubCart() {
  let codes: string[] = []
  let refuseNext: NymbalApiError | null = null
  const answer = async (): Promise<ShopperCart> => answerFor(codes)
  const refusable = async (change: () => void): Promise<ShopperCart> => {
    if (refuseNext !== null) {
      const err = refuseNext
      refuseNext = null
      throw err
    }
    change()
    return answerFor(codes)
  }
  const cart = {
    get: answer,
    addItem: answer,
    removeItem: answer,
    updateQuantity: answer,
    clear: answer,
    addCode: (code: string) => refusable(() => (codes = [...codes, code])),
    removeCode: (code: string) => refusable(() => (codes = codes.filter((c) => c !== code))),
  }
  return {
    adapter: { cart } as unknown as CommerceAdapter,
    refuse: (err: NymbalApiError) => {
      refuseNext = err
    },
  }
}

function wrapperFor(client: NymbalClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <NymbalProvider client={client}>{children}</NymbalProvider>
  }
}

describe('AC-22: useCart reaches the code calls', () => {
  // Kills: a React storefront with no way to the code calls, a hook that re-renders with stale totals, or a refusal
  // the hook does not surface.
  it('AC-22: after addCode the hook’s state carries the answer’s totals and promotions, after removeCode the code is gone from them, and a refusal shows in errorCode with the totals kept', async () => {
    const stub = stubCart()
    const store = createCartStore(stub.adapter)
    const client = { cart: store } as unknown as NymbalClient
    const { result } = renderHook(() => useCart(), { wrapper: wrapperFor(client) })
    await act(() => result.current.load())
    expect(result.current.totals, 'the loaded cart’s totals').toEqual(answerFor([]).totals)
    const undiscounted = result.current.totals!.totalMinor

    await act(() => result.current.addCode('SAVE10'))
    expect(result.current.promotions).toEqual(answerFor(['SAVE10']).promotions)
    expect(result.current.totals).toEqual(answerFor(['SAVE10']).totals)
    expect(result.current.totals!.totalMinor).toBe(
      undiscounted - result.current.totals!.discountTotalMinor,
    )

    await act(() => result.current.removeCode('SAVE10'))
    expect(result.current.promotions.codes.map((c: CartCodeStatus) => c.code)).not.toContain('SAVE10')
    expect(result.current.totals?.totalMinor).toBe(undiscounted)

    stub.refuse(new NymbalApiError('cart.code_limit', 'a cart holds at most 5 codes', 400))
    await act(() => result.current.addCode('SIXTH'))
    expect(result.current.errorCode).toBe('cart.code_limit')
    expect(result.current.totals?.totalMinor).toBe(undiscounted)
    expect(result.current.promotions.codes).toEqual([])
  })
})
