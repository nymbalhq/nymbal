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

// A captured order is refunded from any status between confirmed and delivered; a partial refund leaves room for more.
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled', 'refunded', 'partially_refunded'],
  processing: ['shipped', 'cancelled', 'refunded', 'partially_refunded'],
  shipped: ['delivered', 'refunded', 'partially_refunded'],
  delivered: ['refunded', 'partially_refunded'],
  cancelled: [],
  refunded: [],
  partially_refunded: ['refunded'],
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
  createdAt: string
  updatedAt: string
}

/**
 * The request header a shopper's order key travels in to `GET /api/orders/:orderNumber`. Never a query parameter, so
 * the key stays out of access logs that record request URLs.
 */
export const ORDER_KEY_HEADER = 'x-nymbal-order-key'

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
