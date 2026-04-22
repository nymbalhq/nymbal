import type * as P from './payloads.js'
import * as C from './constants.js'

export interface NymbalEventMap {
  [C.EVT_PRODUCT_CREATED]: P.ProductCreatedV1Payload
  [C.EVT_PRODUCT_UPDATED]: P.ProductUpdatedV1Payload
  [C.EVT_PRODUCT_DELETED]: P.ProductDeletedV1Payload
  [C.EVT_PRODUCT_PUBLISHED]: P.ProductPublishedV1Payload
  [C.EVT_PRODUCT_UNPUBLISHED]: P.ProductUnpublishedV1Payload

  [C.EVT_CATEGORY_CREATED]: P.CategoryCreatedV1Payload
  [C.EVT_CATEGORY_UPDATED]: P.CategoryUpdatedV1Payload
  [C.EVT_CATEGORY_DELETED]: P.CategoryDeletedV1Payload

  [C.EVT_ORDER_PLACED]: P.OrderPlacedV1Payload
  [C.EVT_ORDER_PAID]: P.OrderPaidV1Payload
  [C.EVT_ORDER_FULFILLED]: P.OrderFulfilledV1Payload
  [C.EVT_ORDER_SHIPPED]: P.OrderShippedV1Payload
  [C.EVT_ORDER_DELIVERED]: P.OrderDeliveredV1Payload
  [C.EVT_ORDER_CANCELLED]: P.OrderCancelledV1Payload
  [C.EVT_ORDER_REFUNDED]: P.OrderRefundedV1Payload
  [C.EVT_ORDER_PARTIALLY_REFUNDED]: P.OrderPartiallyRefundedV1Payload

  [C.EVT_INVENTORY_CHANGED]: P.InventoryChangedV1Payload
  [C.EVT_INVENTORY_RESERVED]: P.InventoryReservedV1Payload
  [C.EVT_INVENTORY_RELEASED]: P.InventoryReleasedV1Payload
  [C.EVT_INVENTORY_LOW_STOCK]: P.InventoryLowStockV1Payload
  [C.EVT_INVENTORY_OUT_OF_STOCK]: P.InventoryOutOfStockV1Payload

  [C.EVT_CUSTOMER_CREATED]: P.CustomerCreatedV1Payload
  [C.EVT_CUSTOMER_UPDATED]: P.CustomerUpdatedV1Payload
  [C.EVT_CUSTOMER_DELETED]: P.CustomerDeletedV1Payload

  [C.EVT_CART_CREATED]: P.CartCreatedV1Payload
  [C.EVT_CART_ITEM_ADDED]: P.CartItemAddedV1Payload
  [C.EVT_CART_ITEM_REMOVED]: P.CartItemRemovedV1Payload
  [C.EVT_CART_UPDATED]: P.CartUpdatedV1Payload
  [C.EVT_CART_ABANDONED]: P.CartAbandonedV1Payload
  [C.EVT_CART_CONVERTED]: P.CartConvertedV1Payload

  [C.EVT_PAYMENT_CAPTURED]: P.PaymentCapturedV1Payload
  [C.EVT_PAYMENT_FAILED]: P.PaymentFailedV1Payload
  [C.EVT_PAYMENT_REFUNDED]: P.PaymentRefundedV1Payload

  [C.EVT_ADAPTER_ERROR]: P.AdapterErrorV1Payload
}

export type NymbalEventType = keyof NymbalEventMap
export type PayloadOf<E extends NymbalEventType> = NymbalEventMap[E]
