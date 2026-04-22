import {
  EVT_ORDER_CANCELLED,
  EVT_ORDER_DELIVERED,
  EVT_ORDER_PAID,
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_ORDER_PLACED,
  EVT_ORDER_REFUNDED,
  EVT_ORDER_SHIPPED,
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type Order,
  type OrderPlacedV1Payload,
  type OrderStatus,
} from '@nymbal/types'
import type { OrderRepository } from '../../repositories/order.js'
import type { OrderHistoryRepository } from '../../repositories/order-history.js'

const ORDERS = 'orders'
const ORDERS_BY_CUSTOMER = 'orders-by-customer'

function customerSortKey(o: Order): string {
  // descending by timestamp prefix + stable order number
  return `order:${String(Number.MAX_SAFE_INTEGER - new Date(String(o.createdAt)).getTime()).padStart(
    16,
    '0',
  )}:${o.orderNumber}`
}

export interface RegisterOrderProjectionDeps {
  eventBus: EventBusAdapter
  documentStore: DocumentStoreAdapter
  logger: Logger
  orderRepo: OrderRepository
  orderHistoryRepo: OrderHistoryRepository
}

interface OrderDoc extends Order {
  history: Array<{
    fromStatus: OrderStatus | null
    toStatus: OrderStatus
    actor: string
    note: string
    timestamp: string
  }>
  partitionKey?: string
  sortKey?: string
}

export async function registerOrderProjection(deps: RegisterOrderProjectionDeps): Promise<void> {
  const { eventBus, documentStore, logger, orderRepo, orderHistoryRepo } = deps

  async function reprojectByOrderId(orderId: string): Promise<void> {
    const order = await orderRepo.findById(orderId)
    if (!order) return
    const history = await orderHistoryRepo.listByOrder(order.id)
    const doc: OrderDoc = {
      ...order,
      history: history.map((h) => ({
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        actor: h.actor,
        note: h.note,
        timestamp: String(h.timestamp),
      })),
    }
    await documentStore.put<OrderDoc>(ORDERS, order.orderNumber, doc)
    if (order.customerId) {
      await documentStore.put<OrderDoc>(
        ORDERS_BY_CUSTOMER,
        `customer:${order.customerId}#${customerSortKey(order)}`,
        {
          ...doc,
          partitionKey: `customer:${order.customerId}`,
          sortKey: customerSortKey(order),
        },
      )
    }
    logger.debug({ orderNumber: order.orderNumber, status: order.status }, 'order projected')
  }

  const onPlaced: EventHandler<OrderPlacedV1Payload> = async (event) => {
    await reprojectByOrderId(event.payload.order.id)
  }

  const onStatusChange: EventHandler<{ orderId: string }> = async (event) => {
    await reprojectByOrderId(event.payload.orderId)
  }

  await eventBus.subscribe(EVT_ORDER_PLACED, onPlaced as EventHandler, {
    name: 'order-projection-placed',
  })
  await eventBus.subscribe(
    [
      EVT_ORDER_PAID,
      EVT_ORDER_SHIPPED,
      EVT_ORDER_DELIVERED,
      EVT_ORDER_CANCELLED,
      EVT_ORDER_REFUNDED,
      EVT_ORDER_PARTIALLY_REFUNDED,
    ],
    onStatusChange as EventHandler,
    { name: 'order-projection-status' },
  )
}
