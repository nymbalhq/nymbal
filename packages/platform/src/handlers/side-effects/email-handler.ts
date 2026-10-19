import {
  EVT_CART_ABANDONED,
  EVT_CUSTOMER_CREATED,
  EVT_ORDER_PAID,
  EVT_ORDER_SHIPPED,
  type CartAbandonedV1Payload,
  type CustomerCreatedV1Payload,
  type EmailAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type OrderPaidV1Payload,
  type OrderShippedV1Payload,
} from '@nymbalhq/types'
import { formatMoney } from '../../money.js'
import { withIdempotency } from '../idempotency.js'
import type { OrderRepository } from '../../repositories/order.js'
import type { ProcessedEventRepository } from '../../repositories/processed-event.js'

/** The handler name of the order-placed email's records: one per order, whatever number of order.paid it gets. */
const ORDER_PAID_EMAIL = 'email:order-paid'

export interface RegisterEmailHandlerDeps {
  eventBus: EventBusAdapter
  email: EmailAdapter
  logger: Logger
  processedEventRepo: ProcessedEventRepository
  orderRepo: OrderRepository
  storeName: string
}

export async function registerEmailHandler(deps: RegisterEmailHandlerDeps): Promise<void> {
  const { eventBus, email, logger, processedEventRepo, orderRepo, storeName } = deps

  // Sent on payment, never at placement: an unpaid order (or an imported one) emails nobody. Keyed per order, so a
  // second order.paid for the order (a redelivered or replayed event) sends nothing more.
  const onOrderPaid: EventHandler<OrderPaidV1Payload> = async (event) => {
    const { orderId } = event.payload
    const { store } = processedEventRepo
    if (await store.read((tx) => processedEventRepo.seen(tx, ORDER_PAID_EMAIL, orderId))) return
    const order = await orderRepo.store.read((tx) => orderRepo.findById(tx, orderId))
    if (order === null) {
      logger.warn({ orderId, eventId: event.id }, 'email handler: paid order not found')
      return
    }
    await email.sendTransactional({
      template: 'order-placed',
      to: order.email,
      vars: {
        orderNumber: order.orderNumber,
        customerName: order.billingAddress.firstName,
        totalFormatted: formatMoney(order.totalMinor, order.currency),
      },
    })
    await store.transaction((tx) =>
      processedEventRepo.markProcessed(tx, ORDER_PAID_EMAIL, orderId, new Date()),
    )
  }

  const onOrderShipped: EventHandler<OrderShippedV1Payload> = async (event) => {
    logger.debug({ orderId: event.payload.orderId }, 'email handler: order shipped')
    // Need to look up customer email; skip in v0.1 (requires order repo).
  }

  const onCustomerCreated: EventHandler<CustomerCreatedV1Payload> = async (event) => {
    await email.sendTransactional({
      template: 'welcome',
      to: event.payload.email,
      vars: { customerName: 'there', storeName },
    })
  }

  const onCartAbandoned: EventHandler<CartAbandonedV1Payload> = async (event) => {
    logger.debug({ cartId: event.payload.cartId }, 'email handler: cart abandoned (stub)')
  }

  await eventBus.subscribe(EVT_ORDER_PAID, onOrderPaid as EventHandler, {
    name: 'email-order-paid',
  })
  await eventBus.subscribe(
    EVT_ORDER_SHIPPED,
    withIdempotency('email:order-shipped', onOrderShipped as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'email-order-shipped' },
  )
  await eventBus.subscribe(
    EVT_CUSTOMER_CREATED,
    withIdempotency('email:customer-created', onCustomerCreated as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'email-customer-created' },
  )
  await eventBus.subscribe(
    EVT_CART_ABANDONED,
    withIdempotency('email:cart-abandoned', onCartAbandoned as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'email-cart-abandoned' },
  )
}
