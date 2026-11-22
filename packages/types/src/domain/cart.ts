import type { OrderSource } from './order.js'
import type { CheckoutTotals, PromotionEffect } from './totals.js'

/** The most of one variant a cart line holds. */
export const CART_LINE_MAX_QTY = 99

export interface CartItem {
  variantId: string
  productId: string
  /** The product page's slug; lines stored before lines carried one have none. */
  productSlug?: string
  productName: string
  variantName: string
  priceMinor: number
  qty: number
  imageUrl: string
}

/** Who opened a cart: the storefront or a shopping agent. An import opens none. */
export type CartSource = Exclude<OrderSource, 'import'>

/** What the promotions engine last said about a cart with codes. */
export interface CartPromotions {
  codes: string[]
  effects: PromotionEffect[]
  provider: string
  evaluatedAt: string
  /** The engine could not be reached at the last evaluation: the effects are empty, not the last known discount. */
  unavailable: boolean
}

export interface Cart {
  token: string
  customerId: string | null
  items: CartItem[]
  subtotalMinor: number
  currency: string
  source: CartSource
  expiresAt: string
  createdAt: string
  updatedAt: string
  /** Absent while the cart holds no code. */
  promotions?: CartPromotions
}

/** What the engine last said of one code on a cart; `reason` is the engine's own for a rejected code. */
export interface CartCodeStatus {
  code: string
  status: 'accepted' | 'rejected' | 'pending'
  reason?: string
}

export interface CartCodes {
  codes: CartCodeStatus[]
  /** The engine could not be reached at the last evaluation: every code is `pending`. */
  unavailable: boolean
}

/** A cart as the cart routes answer it: the stored cart, what it comes to, and what the engine said of each code. */
export interface ShopperCart extends Omit<Cart, 'promotions'> {
  totals: CheckoutTotals
  promotions: CartCodes
}
