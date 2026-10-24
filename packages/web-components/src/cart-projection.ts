import type { NymbalClient } from '@nymbalhq/sdk'
import type { CartItem } from '@nymbalhq/types'
import { parsedJson } from './base-element.js'

/**
 * The cart a server hands an element as its `cart` attribute: the lines and their sums, never the `GET /api/cart`
 * body, which carries the cart token the API keeps in an HttpOnly cookie.
 */
export interface CartProjection {
  items: CartItem[]
  subtotalMinor: number
  currency: string
  itemCount: number
}

/** What a cart element shows; `loading` until the cart is known. */
export interface ShownCart extends CartProjection {
  loading: boolean
}

/** No cart given and no store to read: the element's loading shell, never a false empty cart. */
const UNKNOWN: ShownCart = { items: [], subtotalMinor: 0, currency: 'GBP', itemCount: 0, loading: true }

/** The cart a server gave the element while it stands, else the cart store's when there is a client. */
export function shownCart(host: Element, given: unknown, client: NymbalClient | null): ShownCart {
  const cart = parsedJson<CartProjection>(host, 'cart', given)
  if (cart !== undefined) return { ...cart, loading: false }
  return client === null ? UNKNOWN : client.cart.getState()
}
