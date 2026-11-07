import { StatusTransitionError } from '../errors.js'

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded'

// A captured order is refunded from any status between confirmed and delivered; a partial refund leaves room for more,
// and the order may still be fulfilled from where it was refunded (`orderMovesFrom`).
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled', 'refunded', 'partially_refunded'],
  processing: ['shipped', 'cancelled', 'refunded', 'partially_refunded'],
  shipped: ['delivered', 'refunded', 'partially_refunded'],
  delivered: ['refunded', 'partially_refunded'],
  cancelled: [],
  refunded: [],
  partially_refunded: ['processing', 'shipped', 'delivered', 'refunded'],
}

const FULFILMENT_MOVES: readonly OrderStatus[] = ['processing', 'shipped', 'delivered']

/**
 * The status an order was in when a partial refund moved it to `partially_refunded`: the `fromStatus` of the last row
 * into `partially_refunded` from another status. Null when no row says (an imported order).
 */
export function statusBeforePartialRefund(
  history: ReadonlyArray<Pick<OrderHistoryEntry, 'fromStatus' | 'toStatus'>>,
): OrderStatus | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]!
    if (
      row.toStatus === 'partially_refunded' &&
      row.fromStatus !== null &&
      row.fromStatus !== 'partially_refunded'
    ) {
      return row.fromStatus
    }
  }
  return null
}

/**
 * Where an order may move. A partially refunded order moves on only as the status it was refunded at would, so
 * fulfilment never goes backwards or repeats; with that status unknown the table's row applies.
 */
export function orderMovesFrom(
  status: OrderStatus,
  before: OrderStatus | null,
): readonly OrderStatus[] {
  if (status !== 'partially_refunded' || before === null) return ORDER_STATUS_TRANSITIONS[status]
  const onward = ORDER_STATUS_TRANSITIONS[before]
  return ['refunded', ...FULFILMENT_MOVES.filter((m) => onward.includes(m))]
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to)
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new StatusTransitionError('order', from, to)
  }
}

export interface Address {
  firstName: string
  lastName: string
  company?: string
  addressLine1: string
  addressLine2?: string
  city: string
  region: string
  postalCode: string
  country: string
  phone?: string
}

export interface OrderLineItem {
  variantId: string
  productId: string
  productName: string
  variantName: string
  sku: string
  qty: number
  unitPriceMinor: number
  lineSubtotalMinor: number
  lineTaxMinor: number
  lineTotalMinor: number
  imageUrl: string
}

/** Where an order came from: the storefront, an import, or the shopping agent that opened its cart. */
export type OrderSource = 'storefront' | 'import' | `agent:${string}`

/** The source a cart or order opened by the named agent carries. */
export function agentSource(name: string): `agent:${string}` {
  return `agent:${name}`
}

export interface Order {
  id: string
  orderNumber: string
  sequence: number
  customerId: string | null
  status: OrderStatus
  email: string
  billingAddress: Address
  shippingAddress: Address
  lineItems: OrderLineItem[]
  subtotalMinor: number
  taxTotalMinor: number
  shippingTotalMinor: number
  discountTotalMinor: number
  totalMinor: number
  currency: string
  notes: string
  metadata: Record<string, unknown>
  paymentIntentId: string | null
  /** Money taken for the order, in minor units of its currency; 0 while nothing is captured. */
  capturedMinor: number
  capturedAt: string | null
  /** Σ of the order's succeeded refunds (or, for an import or a pre-refund-table order, what was refunded then). */
  refundedMinor: number
  captureMethod: CaptureMethod | null
  source: OrderSource
  createdAt: string
  updatedAt: string
}

/**
 * The request header a shopper's order key travels in to `GET /api/orders/:orderNumber`. Never a query parameter, so
 * the key stays out of access logs that record request URLs.
 */
export const ORDER_KEY_HEADER = 'x-nymbal-order-key'

/** The request header that carries the order's email beside an expired order key. Never a query parameter either. */
export const ORDER_EMAIL_HEADER = 'x-nymbal-order-email'

/**
 * The API's attestation of a shopper's address on a page request it forwards to the storefront. The storefront server
 * echoes it on the API calls it makes for that shopper, so they count against the shopper's address, not its own.
 */
export const SHOPPER_ATTESTATION_HEADER = 'x-nymbal-shopper'

/** Who took the money: the payments provider, the merchant recording an offline payment, or an imported history. */
export type CaptureMethod = 'provider' | 'manual' | 'import'

export type OrderRefundStatus = 'pending' | 'succeeded' | 'failed'

/** One refund of an order. `pending` until the provider's answer settles it, and counted against what is refundable. */
export interface OrderRefund {
  id: string
  orderId: string
  amountMinor: number
  currency: string
  providerRefundId: string | null
  status: OrderRefundStatus
  reason: string | null
  actor: string
  createdAt: string
}

export type PaymentState = 'unpaid' | 'paid' | 'partially_refunded' | 'refunded'

/** What the admin shows about an order's money: derived from the stored amounts and refunds alone. */
export interface OrderPayment {
  state: PaymentState
  capturedMinor: number
  refundedMinor: number
  refundableMinor: number
  currency: string
  refunds: OrderRefund[]
}

export function paymentState(order: Pick<Order, 'capturedMinor' | 'refundedMinor'>): PaymentState {
  if (order.capturedMinor <= 0) return 'unpaid'
  if (order.refundedMinor <= 0) return 'paid'
  return order.refundedMinor < order.capturedMinor ? 'partially_refunded' : 'refunded'
}

/** What can still be refunded: the capture less what was refunded and what is still pending with the provider. */
export function refundableMinor(
  order: Pick<Order, 'capturedMinor' | 'refundedMinor'>,
  refunds: ReadonlyArray<Pick<OrderRefund, 'amountMinor' | 'status'>>,
): number {
  const pending = refunds
    .filter((r) => r.status === 'pending')
    .reduce((sum, r) => sum + r.amountMinor, 0)
  return Math.max(0, order.capturedMinor - order.refundedMinor - pending)
}

export interface OrderHistoryEntry {
  id: string
  orderId: string
  fromStatus: OrderStatus | null
  toStatus: OrderStatus
  actor: string
  note: string
  timestamp: string
}
