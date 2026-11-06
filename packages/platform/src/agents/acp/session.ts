import type { Cart, Order } from '@nymbalhq/types'
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
}

/** One of a session's `messages`: ACP's `MessageError`. */
export interface AcpMessage {
  type: 'error'
  code: string
  content_type: 'plain'
  content: string
  param?: string
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

/** The one fulfillment option a session offers: the free shipping the storefront's checkout charges. */
export const STANDARD_FULFILLMENT = 'standard'

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
export function missingMessages(stored: StoredSession): AcpMessage[] {
  const messages: AcpMessage[] = []
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

/**
 * A session in ACP's `CheckoutSession` shape. Money is the lines' minor units, unconverted: the session's total is the
 * sum of its line totals, which is the cart's subtotal and what checkout charges (no shipping, no tax).
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
  return {
    id: input.id,
    status: input.status,
    currency: input.currency.toLowerCase(),
    ...(stored.buyer !== undefined && { buyer: stored.buyer }),
    line_items: lineItems,
    ...(stored.fulfillment_details !== undefined && {
      fulfillment_details: stored.fulfillment_details,
    }),
    fulfillment_options: [
      {
        type: 'shipping',
        id: STANDARD_FULFILLMENT,
        title: 'Standard shipping',
        totals: [total('total', 'Shipping', 0)],
      },
    ],
    ...(stored.selected_fulfillment_options !== undefined && {
      selected_fulfillment_options: stored.selected_fulfillment_options,
    }),
    totals: [
      total('items_base_amount', 'Item(s) total', sum),
      total('subtotal', 'Subtotal', sum),
      total('fulfillment', 'Shipping', 0),
      total('tax', 'Tax', 0),
      total('total', 'Total', sum),
    ],
    messages: input.messages,
    links: input.links.map((link) => ({ ...(link as Record<string, unknown>) })),
    capabilities: { payment: { handlers: [input.handler] } },
    ...(input.expiresAt !== undefined && { expires_at: input.expiresAt }),
    ...(input.order !== undefined && { order: input.order }),
  }
}
