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

/** What a shopper is told of a code the engine refused, by the engine's reason; any other reason reads as not valid. */
const REFUSED_CODE_MESSAGES: Readonly<Record<string, string>> = {
  expired: 'This code has expired.',
  below_minimum: "Your order is below this code's minimum spend.",
  cap_reached: 'This code has been fully used.',
  wrong_currency: "This code can't be used in this currency.",
  one_code_per_order: 'Only one code can be used per order.',
  free_order_unsupported: "This code can't be used on this order.",
}

/** The one message every surface gives for a code on a cart: the storefront beside it, ACP in its warning. */
export function cartCodeMessage(code: Pick<CartCodeStatus, 'status' | 'reason'>): string {
  if (code.status === 'accepted') return 'Applied'
  if (code.status === 'pending') return "We couldn't check this code just now."
  const reason = code.reason ?? ''
  return Object.hasOwn(REFUSED_CODE_MESSAGES, reason)
    ? REFUSED_CODE_MESSAGES[reason]!
    : "This code isn't valid."
}
