import {
  EVT_CART_ABANDONED,
  EVT_CUSTOMER_CREATED,
  EVT_ORDER_PLACED,
  EVT_ORDER_SHIPPED,
  type CartAbandonedV1Payload,
  type CustomerCreatedV1Payload,
  type EmailAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type OrderPlacedV1Payload,
  type OrderShippedV1Payload,
} from '@nymbal/types'
import { withIdempotency } from '../idempotency.js'
import type { ProcessedEventRepository } from '../../repositories/processed-event.js'

export interface RegisterEmailHandlerDeps {
  eventBus: EventBusAdapter
  email: EmailAdapter
  logger: Logger
  processedEventRepo: ProcessedEventRepository
  storeName: string
}

export async function registerEmailHandler(deps: RegisterEmailHandlerDeps): Promise<void> {
  const { eventBus, email, logger, processedEventRepo, storeName } = deps

  const onOrderPlaced: EventHandler<OrderPlacedV1Payload> = async (event) => {
    const order = event.payload.order
    await email.sendTransactional({
      template: 'order-placed',
      to: order.email,
      vars: {
        orderNumber: order.orderNumber,
        customerName: order.billingAddress.firstName,
        totalFormatted: `${order.totalMinor / 100} ${order.currency.toUpperCase()}`,
      },
    })
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

  await eventBus.subscribe(
    EVT_ORDER_PLACED,
    withIdempotency('email:order-placed', onOrderPlaced as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'email-order-placed' },
  )
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
