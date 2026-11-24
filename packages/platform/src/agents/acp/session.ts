import {
  cartCodeMessage,
  type Cart,
  type CartCodeStatus,
  type Order,
  type PromotionEffect,
  type ShippingOption,
} from '@nymbalhq/types'
import type { AcpAddress } from './address.js'

/** The statuses this store answers a session with, of the protocol's. */
export type AcpStatus =
  | 'not_ready_for_payment'
  | 'ready_for_payment'
  | 'complete_in_progress'
  | 'completed'
  | 'canceled'

export interface AcpBuyer {
  email: string
  first_name?: string | undefined
  last_name?: string | undefined
  full_name?: string | undefined
  phone_number?: string | undefined
}

export interface AcpFulfillmentDetails {
  name?: string | undefined
  phone_number?: string | undefined
  email?: string | undefined
  address?: AcpAddress | undefined
}

export interface AcpSelectedFulfillment {
  type: string
  option_id: string
  item_ids: string[]
}

/** What a session holds beside its cart, in the `acp_sessions` document keyed by the cart's token. */
export interface StoredSession {
  buyer?: AcpBuyer
  fulfillment_details?: AcpFulfillmentDetails
  selected_fulfillment_options?: AcpSelectedFulfillment[]
  /** ISO time the agent cancelled the session; only this mark makes a session `canceled`. */
  canceledAt?: string
  /** The total and option the last POST answered: what `complete` acknowledges. */
  quoted?: { totalMinor: number; optionId: string }
}

/** ACP's `MessageError`. */
export interface AcpErrorMessage {
  type: 'error'
  code: string
  content_type: 'plain'
  content: string
  param?: string
}

/** One of a session's `messages`: ACP's `MessageError`, `MessageWarning` or `MessageInfo`. */
export type AcpMessage =
  | AcpErrorMessage
  | {
      type: 'warning'
      code: string
      severity: 'medium' | 'high'
      resolution: 'requires_buyer_input' | 'requires_buyer_review'
      param?: string
      content_type: 'plain'
      content: string
    }
  | {
      type: 'info'
      severity: 'high'
      resolution: 'recoverable'
      content_type: 'plain'
      content: string
    }

/** ACP's `Order`, as a session answers it once completed. */
export interface AcpOrder {
  type: 'order'
  id: string
  order_number: string
  checkout_session_id: string
  permalink_url: string
  status: string
}

/** The option a store with no shipping table offers: free. */
export const STANDARD_FULFILLMENT: ShippingOption = {
  id: 'standard',
  name: 'Standard shipping',
  amountMinor: 0,
  estimatedDays: null,
}

/** A session's money, as a checkout quote or an order's columns give it. */
export interface SessionTotals {
  subtotalMinor: number
  discountTotalMinor: number
  shippingTotalMinor: number
  taxTotalMinor: number
  totalMinor: number
  pricesIncludeTax: boolean
}

/**
 * What a session is charged: priced (a quote, or the order's columns) at an option the totals used; or unpriced, with
 * the options it can show and the agent's stored choice, at its cart's totals (no shipping or tax) or else its lines'
 * sum.
 */
export type SessionPricing =
  | { kind: 'priced'; options: ShippingOption[]; optionId: string; totals: SessionTotals }
  | { kind: 'unpriced'; options: ShippingOption[]; totals?: SessionTotals }

/** ACP's `DiscountErrorCode`, of which this store answers these. */
export type DiscountErrorCode =
  | 'discount_code_expired'
  | 'discount_code_invalid'
  | 'discount_code_combination_disallowed'
  | 'discount_code_minimum_not_met'
  | 'discount_code_usage_limit_reached'

const DISCOUNT_ERROR_CODES: Readonly<Record<string, DiscountErrorCode>> = {
  expired: 'discount_code_expired',
  below_minimum: 'discount_code_minimum_not_met',
  cap_reached: 'discount_code_usage_limit_reached',
  one_code_per_order: 'discount_code_combination_disallowed',
}

/** The protocol's reason for an engine's refusal of a code; one it has no word for is invalid. */
export function discountErrorCode(reason: string): DiscountErrorCode {
  return Object.hasOwn(DISCOUNT_ERROR_CODES, reason)
    ? DISCOUNT_ERROR_CODES[reason]!
    : 'discount_code_invalid'
}

/** ACP's `DiscountsResponse`. */
export interface AcpDiscounts {
  codes: string[]
  applied: Array<{
    id: string
    code: string
    coupon: { id: string; name: string }
    amount: number
  }>
  rejected: Array<{ code: string; reason: DiscountErrorCode; message: string }>
}

/**
 * A session's `discounts`: the cart's codes; one applied entry per code among the money effects its totals applied, at
 * the sum of that code's effects, named as the cart spells it; each refused code with its reason. A pending code is in
 * neither list.
 */
export function acpDiscounts(
  codes: readonly CartCodeStatus[],
  applied: readonly PromotionEffect[],
): AcpDiscounts {
  const entries = new Map<string, AcpDiscounts['applied'][number]>()
  for (const effect of applied) {
    if (effect.kind !== 'line' && effect.kind !== 'order' && effect.kind !== 'shipping') continue
    if (effect.code === undefined) continue
    const key = effect.code.toLowerCase()
    const entry = entries.get(key)
    if (entry !== undefined) {
      entry.amount += effect.amountMinor
      continue
    }
    const code = codes.find((c) => c.code.toLowerCase() === key)?.code ?? effect.code
    entries.set(key, {
      id: code,
      code,
      coupon: { id: code, name: effect.label },
      amount: effect.amountMinor,
    })
  }
  return {
    codes: codes.map((c) => c.code),
    applied: [...entries.values()],
    rejected: codes
      .filter((c) => c.status === 'rejected')
      .map((c) => ({
        code: c.code,
        reason: discountErrorCode(c.reason ?? ''),
        message: cartCodeMessage(c),
      })),
  }
}

/** A warning per refused code, pointing at it in `discounts.codes`; a refused code does not hold up payment. */
export function discountWarnings(discounts: AcpDiscounts): AcpMessage[] {
  return discounts.rejected.map((rejected) => ({
    type: 'warning',
    code: rejected.reason,
    severity: 'medium',
    resolution: 'requires_buyer_input',
    param: `$.discounts.codes[${discounts.codes.indexOf(rejected.code)}]`,
    content_type: 'plain',
    content: rejected.message,
  }))
}

/** The extension a session's `discounts` belongs to, declared on every session. */
const DISCOUNT_EXTENSION = { name: 'discount', extends: ['$.CheckoutSession.discounts'] }

/** An order's money columns. */
export function orderTotals(order: Order): SessionTotals {
  return {
    subtotalMinor: order.subtotalMinor,
    discountTotalMinor: order.discountTotalMinor,
    shippingTotalMinor: order.shippingTotalMinor,
    taxTotalMinor: order.taxTotalMinor,
    totalMinor: order.totalMinor,
    pricesIncludeTax: order.pricesIncludeTax ?? false,
  }
}

interface SessionLine {
  variantId: string
  productName: string
  variantName: string
  unitMinor: number
  qty: number
}

export function cartLines(cart: Cart): SessionLine[] {
  return cart.items.map((item) => ({
    variantId: item.variantId,
    productName: item.productName,
    variantName: item.variantName,
    unitMinor: item.priceMinor,
    qty: item.qty,
  }))
}

export function orderLines(order: Order): SessionLine[] {
  return order.lineItems.map((item) => ({
    variantId: item.variantId,
    productName: item.productName,
    variantName: item.variantName,
    unitMinor: item.unitPriceMinor,
    qty: item.qty,
  }))
}

function total(type: string, display_text: string, amount: number) {
  return { type, display_text, amount }
}

/** The `missing` messages of a session without the buyer's email or the address to ship to. */
export function missingMessages(stored: StoredSession): AcpErrorMessage[] {
  const messages: AcpErrorMessage[] = []
  if (stored.buyer?.email === undefined) {
    messages.push({
      type: 'error',
      code: 'missing',
      content_type: 'plain',
      content: "The buyer's email is required.",
      param: '$.buyer.email',
    })
  }
  if (stored.fulfillment_details?.address === undefined) {
    messages.push({
      type: 'error',
      code: 'missing',
      content_type: 'plain',
      content: 'An address to ship to is required.',
      param: '$.fulfillment_details.address',
    })
  }
  return messages
}

/** ACP's totals for a priced session: the goods, their discount, shipping, tax, and the total charged. */
function pricedTotals(t: SessionTotals) {
  return [
    total('items_base_amount', 'Item(s) total', t.subtotalMinor),
    ...(t.discountTotalMinor > 0 ? [total('discount', 'Discount', t.discountTotalMinor)] : []),
    total('subtotal', 'Subtotal', t.subtotalMinor - t.discountTotalMinor),
    total('fulfillment', 'Shipping', t.shippingTotalMinor),
    total('tax', t.pricesIncludeTax ? 'Tax (included)' : 'Tax', t.taxTotalMinor),
    total('total', 'Total', t.totalMinor),
  ]
}

/** ACP's totals before an address: the cart's goods less its discount, no shipping or tax. */
function unpricedTotals(t: SessionTotals | undefined, sum: number) {
  const subtotal = t?.subtotalMinor ?? sum
  const discount = t?.discountTotalMinor ?? 0
  return [
    total('items_base_amount', 'Item(s) total', subtotal),
    ...(discount > 0 ? [total('discount', 'Discount', discount)] : []),
    total('subtotal', 'Subtotal', subtotal - discount),
    total('fulfillment', 'Shipping', 0),
    total('tax', 'Tax', 0),
    total('total', 'Total', t?.totalMinor ?? sum),
  ]
}

/**
 * A session in ACP's `CheckoutSession` shape. Money is in minor units, unconverted: a priced session's totals are its
 * checkout quote's (or its order's), an unpriced one's its cart's (the lines less the codes' discount) with no shipping
 * or tax.
 */
export function acpSession(input: {
  id: string
  status: AcpStatus
  lines: SessionLine[]
  currency: string
  expiresAt?: string | undefined
  stored: StoredSession
  messages: AcpMessage[]
  links: readonly unknown[]
  handler: Record<string, unknown>
  order?: AcpOrder | undefined
  pricing: SessionPricing
  discounts: AcpDiscounts
}): Record<string, unknown> {
  const { stored } = input
  const lineItems = input.lines.map((line) => {
    const amount = line.unitMinor * line.qty
    return {
      id: line.variantId,
      item: { id: line.variantId },
      quantity: line.qty,
      name:
        line.variantName === '' ? line.productName : `${line.productName} – ${line.variantName}`,
      unit_amount: line.unitMinor,
      totals: [total('subtotal', 'Subtotal', amount), total('total', 'Total', amount)],
    }
  })
  const sum = lineItems.reduce((n, line) => n + line.unit_amount * line.quantity, 0)
  const { pricing } = input
  const selected =
    pricing.kind === 'priced'
      ? [
          {
            type: 'shipping',
            option_id: pricing.optionId,
            item_ids: lineItems.map((line) => line.id),
          },
        ]
      : stored.selected_fulfillment_options
  return {
    id: input.id,
    status: input.status,
    currency: input.currency.toLowerCase(),
    ...(stored.buyer !== undefined && { buyer: stored.buyer }),
    line_items: lineItems,
    ...(stored.fulfillment_details !== undefined && {
      fulfillment_details: stored.fulfillment_details,
    }),
    fulfillment_options: pricing.options.map((option) => ({
      type: 'shipping',
      id: option.id,
      title: option.name,
      totals: [total('total', 'Shipping', option.amountMinor)],
    })),
    ...(selected !== undefined && { selected_fulfillment_options: selected }),
    totals:
      pricing.kind === 'priced'
        ? pricedTotals(pricing.totals)
        : unpricedTotals(pricing.totals, sum),
    messages: input.messages,
    links: input.links.map((link) => ({ ...(link as Record<string, unknown>) })),
    discounts: input.discounts,
    capabilities: { payment: { handlers: [input.handler] }, extensions: [DISCOUNT_EXTENSION] },
    ...(input.expiresAt !== undefined && { expires_at: input.expiresAt }),
    ...(input.order !== undefined && { order: input.order }),
  }
}
