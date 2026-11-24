import '@nymbalhq/sdk/ns/cart'
import type { NymbalClient } from '@nymbalhq/sdk'
import type { CartCodeStatus, CartItem } from '@nymbalhq/types'
import { parsedJson } from './base-element.js'

/**
 * The cart a server hands an element as its `cart` attribute: the lines and their sums, what the cart comes to with its
 * codes and what the engine said of each, never the `GET /api/cart` body, which carries the cart token the API keeps in
 * an HttpOnly cookie.
 */
export interface CartProjection {
  items: CartItem[]
  subtotalMinor: number
  currency: string
  itemCount: number
  /** `totals.discountTotalMinor` of `GET /api/cart`. */
  discountTotalMinor: number
  /** `totals.totalMinor` of `GET /api/cart`: no shipping or tax before an address. */
  totalMinor: number
  codes: CartCodeStatus[]
}

/** What a cart element shows; `loading` until the cart is known. */
export interface ShownCart extends CartProjection {
  loading: boolean
}

/** No cart given and no store to read: the element's loading shell, never a false empty cart. */
const UNKNOWN: ShownCart = {
  items: [],
  subtotalMinor: 0,
  currency: 'GBP',
  itemCount: 0,
  discountTotalMinor: 0,
  totalMinor: 0,
  codes: [],
  loading: true,
}

/** The cart a server gave the element while it stands, else the cart store's when there is a client. */
export function shownCart(host: Element, given: unknown, client: NymbalClient | null): ShownCart {
  const cart = parsedJson<CartProjection>(host, 'cart', given)
  if (cart !== undefined) return { ...cart, loading: false }
  if (client === null) return UNKNOWN
  const state = client.cart.getState()
  return {
    items: state.items,
    subtotalMinor: state.subtotalMinor,
    currency: state.currency,
    itemCount: state.itemCount,
    discountTotalMinor: state.totals?.discountTotalMinor ?? 0,
    totalMinor: state.totals?.totalMinor ?? state.subtotalMinor,
    codes: state.promotions.codes,
    loading: state.loading,
  }
}
