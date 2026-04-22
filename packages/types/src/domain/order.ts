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

export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
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
  createdAt: string
  updatedAt: string
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
