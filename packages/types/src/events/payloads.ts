import type { Category } from '../domain/category.js'
import type { Order, OrderLineItem } from '../domain/order.js'
import type { Product, Variant } from '../domain/product.js'
import type { StockAdjustmentReason } from '../domain/inventory.js'

export interface ProductSnapshot extends Product {
  variants: Variant[]
  categoryIds: string[]
}

export interface ProductCreatedV1Payload {
  product: ProductSnapshot
}
export interface ProductUpdatedV1Payload {
  product: ProductSnapshot
}
export interface ProductDeletedV1Payload {
  productId: string
  slug: string
}
export interface ProductPublishedV1Payload {
  productId: string
  slug: string
}
export interface ProductUnpublishedV1Payload {
  productId: string
  slug: string
}

export interface CategoryCreatedV1Payload {
  category: Category
}
export interface CategoryUpdatedV1Payload {
  category: Category
}
export interface CategoryDeletedV1Payload {
  categoryId: string
  slug: string
}

export interface OrderPlacedV1Payload {
  order: Order
}
export interface OrderPaidV1Payload {
  orderId: string
  paymentIntentId: string
  amountMinor: number
  currency: string
}
export interface OrderFulfilledV1Payload {
  orderId: string
}
export interface OrderShippedV1Payload {
  orderId: string
  trackingNumber: string
  carrier: string
}
export interface OrderDeliveredV1Payload {
  orderId: string
}
export interface OrderCancelledV1Payload {
  orderId: string
  reason: string
}
export interface OrderRefundedV1Payload {
  orderId: string
  amountMinor: number
  reason: string
}
export interface OrderPartiallyRefundedV1Payload {
  orderId: string
  amountMinor: number
  lineItems: OrderLineItem[]
  reason: string
}

export interface InventoryChangedV1Payload {
  variantId: string
  previousQty: number
  newQty: number
  reason: StockAdjustmentReason
}
export interface InventoryReservedV1Payload {
  variantId: string
  qty: number
  reservationId: string
  expiresAt: string
}
export interface InventoryReleasedV1Payload {
  variantId: string
  qty: number
  reservationId: string
  reason: 'expired' | 'cancelled' | 'abandoned' | 'committed'
}
export interface InventoryLowStockV1Payload {
  variantId: string
  currentQty: number
  threshold: number
}
export interface InventoryOutOfStockV1Payload {
  variantId: string
}

export interface CustomerCreatedV1Payload {
  customerId: string
  email: string
}
export interface CustomerUpdatedV1Payload {
  customerId: string
}
export interface CustomerDeletedV1Payload {
  customerId: string
}

export interface CartCreatedV1Payload {
  cartId: string
  token: string
}
export interface CartItemAddedV1Payload {
  cartId: string
  variantId: string
  qty: number
}
export interface CartItemRemovedV1Payload {
  cartId: string
  variantId: string
}
export interface CartUpdatedV1Payload {
  cartId: string
  itemCount: number
  totalMinor: number
}
export interface CartAbandonedV1Payload {
  cartId: string
  lastActivityAt: string
}
export interface CartConvertedV1Payload {
  cartId: string
  orderId: string
}

export interface PaymentCapturedV1Payload {
  paymentId: string
  orderId: string
  amountMinor: number
  currency: string
}
export interface PaymentFailedV1Payload {
  paymentId: string
  orderId: string
  reason: string
}
export interface PaymentRefundedV1Payload {
  paymentId: string
  orderId: string
  amountMinor: number
}

export interface AdapterErrorV1Payload {
  adapterType: string
  adapterName: string
  error: { code: string; message: string }
  context: Record<string, unknown>
}
