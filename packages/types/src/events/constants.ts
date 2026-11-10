// Product
export const EVT_PRODUCT_CREATED = 'product.created.v1'
export const EVT_PRODUCT_UPDATED = 'product.updated.v1'
export const EVT_PRODUCT_DELETED = 'product.deleted.v1'
export const EVT_PRODUCT_PUBLISHED = 'product.published.v1'
export const EVT_PRODUCT_UNPUBLISHED = 'product.unpublished.v1'
export const EVT_PRODUCT_VIEWED = 'product.viewed.v1'
/** A variant's stock went from 0 to above 0, in the transaction of the inventory.changed.v1 it accompanies. */
export const EVT_PRODUCT_RESTOCKED = 'product.restocked.v1'
/** A variant's price or compare-at price changed, in the transaction of the product.updated.v1 it accompanies. */
export const EVT_PRODUCT_VARIANT_PRICE_CHANGED = 'product.variant_price_changed.v1'

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
export const EVT_ORDER_STATUS_CHANGED = 'order.status_changed.v1'
export const EVT_ORDER_CONFIRMATION_RESEND_REQUESTED = 'order.confirmation_resend_requested.v1'
/** A carrier refused the tracking number and the order gained a note: no body, as its notes are for staff alone. */
export const EVT_ORDER_NOTE_ADDED = 'order.note_added.v1'
/** An imported order taken back out of the store, with every row it owned. */
export const EVT_ORDER_DELETED = 'order.deleted.v1'

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
export const EVT_CUSTOMER_PASSWORD_RESET_REQUESTED = 'customer.password_reset_requested.v1'
export const EVT_CUSTOMER_VERIFICATION_REQUESTED = 'customer.verification_requested.v1'
export const EVT_CUSTOMER_REGISTERED_AGAIN = 'customer.registered_again.v1'
// Legacy alias (kept so Prompt 1 seed code continues to compile).
export const EVT_CUSTOMER_REGISTERED = EVT_CUSTOMER_CREATED

// Visitor
export const EVT_VISITOR_MERGED = 'visitor.merged.v1'

// Cart
export const EVT_CART_CREATED = 'cart.created.v1'
export const EVT_CART_ITEM_ADDED = 'cart.item_added.v1'
export const EVT_CART_ITEM_REMOVED = 'cart.item_removed.v1'
export const EVT_CART_UPDATED = 'cart.updated.v1'
export const EVT_CART_ABANDONED = 'cart.abandoned.v1'
export const EVT_CART_CONVERTED = 'cart.converted.v1'

// Payment
export const EVT_PAYMENT_INTENT_CREATED = 'payment.intent_created.v1'
export const EVT_PAYMENT_CAPTURED = 'payment.captured.v1'
export const EVT_PAYMENT_FAILED = 'payment.failed.v1'
export const EVT_PAYMENT_REFUNDED = 'payment.refunded.v1'

// Alerts
export const EVT_ALERT_REQUESTED = 'alert.requested.v1'
/** A subscribe for an alert already active: the subscription stands and nothing is sent. */
export const EVT_ALERT_REPEATED = 'alert.repeated.v1'
export const EVT_ALERT_CONFIRMED = 'alert.confirmed.v1'
export const EVT_ALERT_UNSUBSCRIBED = 'alert.unsubscribed.v1'
export const EVT_ALERT_SENT = 'alert.sent.v1'
/** A pending subscription's confirmation was sent; another goes only once the confirmation interval has passed. */
export const EVT_ALERT_CONFIRMATION_SENT = 'alert.confirmation_sent.v1'

// Reviews
/** A review the reviews adapter took for the store; the kernel resolved its reviewer and the order it is verified by. */
export const EVT_REVIEW_SUBMITTED = 'review.submitted.v1'

// Proposals: an agent's write a person or a policy decides
export const EVT_PROPOSAL_CREATED = 'proposal.created.v1'
export const EVT_PROPOSAL_APPROVED = 'proposal.approved.v1'
export const EVT_PROPOSAL_REJECTED = 'proposal.rejected.v1'
export const EVT_PROPOSAL_APPLIED = 'proposal.applied.v1'
export const EVT_PROPOSAL_FAILED = 'proposal.failed.v1'

// Search
export const EVT_SEARCH_ZERO_RESULTS = 'search.zero_results.v1'

// System
export const EVT_ADAPTER_ERROR = 'adapter.error.v1'
export const EVT_SETTINGS_CHANGED = 'settings.changed.v1'

export const STANDARD_EVENT_TYPES = [
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_UPDATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_PUBLISHED,
  EVT_PRODUCT_UNPUBLISHED,
  EVT_PRODUCT_VIEWED,
  EVT_PRODUCT_RESTOCKED,
  EVT_PRODUCT_VARIANT_PRICE_CHANGED,
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
  EVT_ORDER_STATUS_CHANGED,
  EVT_ORDER_CONFIRMATION_RESEND_REQUESTED,
  EVT_ORDER_DELETED,
  EVT_ORDER_NOTE_ADDED,
  EVT_INVENTORY_CHANGED,
  EVT_INVENTORY_RESERVED,
  EVT_INVENTORY_RELEASED,
  EVT_INVENTORY_LOW_STOCK,
  EVT_INVENTORY_OUT_OF_STOCK,
  EVT_CUSTOMER_CREATED,
  EVT_CUSTOMER_UPDATED,
  EVT_CUSTOMER_DELETED,
  EVT_CUSTOMER_PASSWORD_RESET_REQUESTED,
  EVT_CUSTOMER_VERIFICATION_REQUESTED,
  EVT_CUSTOMER_REGISTERED_AGAIN,
  EVT_VISITOR_MERGED,
  EVT_CART_CREATED,
  EVT_CART_ITEM_ADDED,
  EVT_CART_ITEM_REMOVED,
  EVT_CART_UPDATED,
  EVT_CART_ABANDONED,
  EVT_CART_CONVERTED,
  EVT_PAYMENT_INTENT_CREATED,
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_FAILED,
  EVT_PAYMENT_REFUNDED,
  EVT_SEARCH_ZERO_RESULTS,
  EVT_ALERT_REQUESTED,
  EVT_ALERT_REPEATED,
  EVT_ALERT_CONFIRMED,
  EVT_ALERT_UNSUBSCRIBED,
  EVT_ALERT_SENT,
  EVT_ALERT_CONFIRMATION_SENT,
  EVT_REVIEW_SUBMITTED,
  EVT_PROPOSAL_CREATED,
  EVT_PROPOSAL_APPROVED,
  EVT_PROPOSAL_REJECTED,
  EVT_PROPOSAL_APPLIED,
  EVT_PROPOSAL_FAILED,
  EVT_ADAPTER_ERROR,
  EVT_SETTINGS_CHANGED,
] as const
