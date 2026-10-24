import {
  EVT_ORDER_CANCELLED,
  EVT_ORDER_DELIVERED,
  EVT_ORDER_PAID,
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_ORDER_PLACED,
  EVT_ORDER_REFUNDED,
  EVT_ORDER_SHIPPED,
  EVT_ORDER_STATUS_CHANGED,
  EVT_PAYMENT_FAILED,
  EVT_PAYMENT_INTENT_CREATED,
  EVT_PAYMENT_REFUNDED,
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type OrderPlacedV1Payload,
} from '@nymbalhq/types'
import type { OrderRepository } from '../../repositories/order.js'
import type { OrderHistoryRepository } from '../../repositories/order-history.js'
import { orderWrites } from '../../read-models/builders.js'
import { loadOrderDoc } from '../../read-models/sources.js'
import { subscribeDerived, type DerivedHandler } from '../derived.js'

export interface OrderProjectionDeps {
  documentStore: DocumentStoreAdapter
  logger: Logger
  orderRepo: OrderRepository
  orderHistoryRepo: OrderHistoryRepository
}

export interface RegisterOrderProjectionDeps extends OrderProjectionDeps {
  eventBus: EventBusAdapter
}

/** `orders` and `orders-by-customer`, from the order and its history as they are at handle time. */
export function orderProjection(deps: OrderProjectionDeps): DerivedHandler[] {
  const { documentStore, logger, orderRepo, orderHistoryRepo } = deps
  const repos = { order: orderRepo, orderHistory: orderHistoryRepo }

  async function reproject(orderId: string): Promise<void> {
    const doc = await orderRepo.store.read((tx) => loadOrderDoc(tx, repos, orderId))
    if (!doc) return
    for (const w of orderWrites(doc)) await documentStore.put(w.collection, w.key, w.doc)
    logger.debug({ orderNumber: doc.orderNumber, status: doc.status }, 'order projected')
  }

  const onPlaced: EventHandler<OrderPlacedV1Payload> = (event) => reproject(event.payload.order.id)

  const onStatusChange: EventHandler<{ orderId: string }> = (event) =>
    reproject(event.payload.orderId)

  return [
    {
      name: 'order-projection-placed',
      types: [EVT_ORDER_PLACED],
      handle: onPlaced as EventHandler,
    },
    {
      name: 'order-projection-status',
      types: [
        EVT_ORDER_PAID,
        EVT_ORDER_SHIPPED,
        EVT_ORDER_DELIVERED,
        EVT_ORDER_CANCELLED,
        EVT_ORDER_REFUNDED,
        EVT_ORDER_PARTIALLY_REFUNDED,
        EVT_ORDER_STATUS_CHANGED,
      ],
      handle: onStatusChange as EventHandler,
    },
    {
      // A payment's outcome is written on its order (the intent, a failure note, a refund of a cancelled capture).
      name: 'order-projection-payment',
      types: [EVT_PAYMENT_INTENT_CREATED, EVT_PAYMENT_FAILED, EVT_PAYMENT_REFUNDED],
      handle: onStatusChange as EventHandler,
    },
  ]
}

export async function registerOrderProjection(deps: RegisterOrderProjectionDeps): Promise<void> {
  await subscribeDerived(deps.eventBus, orderProjection(deps))
}
