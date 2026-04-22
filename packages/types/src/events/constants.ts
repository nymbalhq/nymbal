// Product
export const EVT_PRODUCT_CREATED = 'product.created.v1'
export const EVT_PRODUCT_UPDATED = 'product.updated.v1'
export const EVT_PRODUCT_DELETED = 'product.deleted.v1'
export const EVT_PRODUCT_PUBLISHED = 'product.published.v1'
export const EVT_PRODUCT_UNPUBLISHED = 'product.unpublished.v1'

// Category
export const EVT_CATEGORY_CREATED = 'category.created.v1'
export const EVT_CATEGORY_UPDATED = 'category.updated.v1'
export const EVT_CATEGORY_DELETED = 'category.deleted.v1'

// Order
export const EVT_ORDER_PLACED = 'order.placed.v1'
export const EVT_ORDER_PAID = 'order.paid.v1'
export const EVT_ORDER_FULFILLED = 'order.fulfilled.v1'
export const EVT_ORDER_SHIPPED = 'order.shipped.v1'
export const EVT_ORDER_DELIVERED = 'order.delivered.v1'
export const EVT_ORDER_CANCELLED = 'order.cancelled.v1'
export const EVT_ORDER_REFUNDED = 'order.refunded.v1'
export const EVT_ORDER_PARTIALLY_REFUNDED = 'order.partially_refunded.v1'

// Inventory
export const EVT_INVENTORY_CHANGED = 'inventory.changed.v1'
export const EVT_INVENTORY_RESERVED = 'inventory.reserved.v1'
export const EVT_INVENTORY_RELEASED = 'inventory.released.v1'
export const EVT_INVENTORY_LOW_STOCK = 'inventory.low_stock.v1'
export const EVT_INVENTORY_OUT_OF_STOCK = 'inventory.out_of_stock.v1'

// Customer
export const EVT_CUSTOMER_CREATED = 'customer.created.v1'
export const EVT_CUSTOMER_UPDATED = 'customer.updated.v1'
export const EVT_CUSTOMER_DELETED = 'customer.deleted.v1'
// Legacy alias (kept so Prompt 1 seed code continues to compile).
export const EVT_CUSTOMER_REGISTERED = EVT_CUSTOMER_CREATED

// Cart
export const EVT_CART_CREATED = 'cart.created.v1'
export const EVT_CART_ITEM_ADDED = 'cart.item_added.v1'
export const EVT_CART_ITEM_REMOVED = 'cart.item_removed.v1'
export const EVT_CART_UPDATED = 'cart.updated.v1'
export const EVT_CART_ABANDONED = 'cart.abandoned.v1'
export const EVT_CART_CONVERTED = 'cart.converted.v1'

// Payment
export const EVT_PAYMENT_CAPTURED = 'payment.captured.v1'
export const EVT_PAYMENT_FAILED = 'payment.failed.v1'
export const EVT_PAYMENT_REFUNDED = 'payment.refunded.v1'

// System
export const EVT_ADAPTER_ERROR = 'adapter.error.v1'

export const STANDARD_EVENT_TYPES = [
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_UPDATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_PUBLISHED,
  EVT_PRODUCT_UNPUBLISHED,
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_UPDATED,
  EVT_CATEGORY_DELETED,
  EVT_ORDER_PLACED,
  EVT_ORDER_PAID,
  EVT_ORDER_FULFILLED,
  EVT_ORDER_SHIPPED,
  EVT_ORDER_DELIVERED,
  EVT_ORDER_CANCELLED,
  EVT_ORDER_REFUNDED,
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_INVENTORY_CHANGED,
  EVT_INVENTORY_RESERVED,
  EVT_INVENTORY_RELEASED,
  EVT_INVENTORY_LOW_STOCK,
  EVT_INVENTORY_OUT_OF_STOCK,
  EVT_CUSTOMER_CREATED,
  EVT_CUSTOMER_UPDATED,
  EVT_CUSTOMER_DELETED,
  EVT_CART_CREATED,
  EVT_CART_ITEM_ADDED,
  EVT_CART_ITEM_REMOVED,
  EVT_CART_UPDATED,
  EVT_CART_ABANDONED,
  EVT_CART_CONVERTED,
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_FAILED,
  EVT_PAYMENT_REFUNDED,
  EVT_ADAPTER_ERROR,
] as const
