import type { CartCodeStatus } from './domain/cart.js'

// An entry of its own (`@nymbalhq/types/cart-codes`), which the storefront's code block imports, so that the messages
// load only on a page holding the block and not with the index on every page.

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
