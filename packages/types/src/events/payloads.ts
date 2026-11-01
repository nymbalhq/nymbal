import type { Category } from '../domain/category.js'
import type { CustomerAddress } from '../domain/customer.js'
import type { Order, OrderStatus } from '../domain/order.js'
import type { Product, Variant } from '../domain/product.js'
import type { StockAdjustmentReason } from '../domain/inventory.js'
import type { AlertKind } from '../alerts.js'
import type { SettingSourceName } from '../settings.js'

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
export interface ProductRestockedV1Payload {
  productId: string
  variantId: string
  previousQty: number
  newQty: number
}
/** Prices in `currency`'s minor units; each compare-at price is the stored one, null when the variant has none. */
export interface ProductVariantPriceChangedV1Payload {
  productId: string
  variantId: string
  previousPriceMinor: number
  priceMinor: number
  previousCompareAtPriceMinor: number | null
  compareAtPriceMinor: number | null
  currency: string
}

/** Whose view it is: an anonymous visitor (the `nymbal.visitor` cookie) or a signed-in customer. */
export interface RecentViewer {
  kind: 'visitor' | 'customer'
  id: string
}

export interface ProductViewedV1Payload {
  productId: string
  viewer: RecentViewer
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
  refundId: string
  amountMinor: number
  currency: string
  reason: string
}
export interface OrderPartiallyRefundedV1Payload {
  orderId: string
  refundId: string
  amountMinor: number
  currency: string
  reason: string
}
/** A status change no other order event names (an admin moving an order to confirmed or processing). */
export interface OrderStatusChangedV1Payload {
  orderId: string
  from: OrderStatus
  to: OrderStatus
}
/** An admin asked for the order's confirmation email again; the email's key is minted when it is sent. */
export interface OrderConfirmationResendRequestedV1Payload {
  orderId: string
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

/** A customer as the event log keeps it: never its password hash, roles, metadata or stats. */
export interface CustomerSnapshot {
  id: string
  email: string
  firstName: string
  lastName: string
  phone: string
  addresses: CustomerAddress[]
  createdAt: string
}

// `customer` is the row after the write; events logged before it was added carry none.
export interface CustomerCreatedV1Payload {
  customerId: string
  email: string
  customer?: CustomerSnapshot
}
export interface CustomerUpdatedV1Payload {
  customerId: string
  customer?: CustomerSnapshot
}
export interface CustomerDeletedV1Payload {
  customerId: string
}

/** A visitor's views now belong to the customer who signed in carrying its cookie. */
export interface VisitorMergedV1Payload {
  visitorId: string
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

/** The provider's intent for an order, stored on the order whatever its outcome. */
export interface PaymentIntentCreatedV1Payload {
  paymentId: string
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
  refundId: string
  amountMinor: number
  currency: string
}

// No alert event carries the subscriber's address or a token.
export interface AlertRequestedV1Payload {
  subscriptionId: string
  kind: AlertKind
  variantId: string
  productId: string
}
export type AlertRepeatedV1Payload = AlertRequestedV1Payload
export interface AlertConfirmedV1Payload {
  subscriptionId: string
}
export interface AlertUnsubscribedV1Payload {
  subscriptionId: string
}
export interface AlertSentV1Payload {
  subscriptionId: string
  kind: AlertKind
  /**
   * The event the alert answered: a product.restocked.v1 for a back-in-stock alert, a
   * product.variant_price_changed.v1 for a price-drop one.
   */
  triggerEventId: string
}

export interface AdapterErrorV1Payload {
  adapterType: string
  adapterName: string
  error: { code: string; message: string }
  context: Record<string, unknown>
}

/** A Settings field was saved or cleared; never the value. `source` is where the field comes from afterwards. */
export interface SettingsChangedV1Payload {
  slot: string
  path: string
  source: SettingSourceName | null
}
