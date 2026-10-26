import { v7 as uuidv7 } from 'uuid'
import {
  EVT_CART_ABANDONED,
  EVT_CUSTOMER_CREATED,
  EVT_ORDER_CONFIRMATION_RESEND_REQUESTED,
  EVT_ORDER_PAID,
  EVT_ORDER_SHIPPED,
  type CartAbandonedV1Payload,
  type CustomerCreatedV1Payload,
  type EmailAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type Order,
  type OrderConfirmationResendRequestedV1Payload,
  type OrderPaidV1Payload,
  type OrderShippedV1Payload,
} from '@nymbalhq/types'
import { formatMoney } from '../../money.js'
import { mintOrderKey } from '../../order-access-key.js'
import { withIdempotency } from '../idempotency.js'
import type { OrderAccessKeyRepository } from '../../repositories/order-access-key.js'
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
  orderAccessKeyRepo: OrderAccessKeyRepository
  storeName: string
  /** The storefront's URL, with no trailing `/`; with none, the order-placed email links nowhere and mints no key. */
  storeUrl?: string
}

export async function registerEmailHandler(deps: RegisterEmailHandlerDeps): Promise<void> {
  const { eventBus, email, logger, processedEventRepo, orderRepo, orderAccessKeyRepo } = deps
  const { storeName, storeUrl } = deps

  /**
   * The order page's link, with a key of the email's own: only the hash of the checkout's key is stored, so the
   * handler never has it.
   */
  async function orderLink(
    base: string,
    order: Order,
  ): Promise<{ orderUrl: string; orderLink: string }> {
    const { key, hash } = mintOrderKey()
    await orderAccessKeyRepo.store.transaction((tx) =>
      orderAccessKeyRepo.insert(tx, {
        id: uuidv7(),
        orderId: order.id,
        keyHash: hash,
        purpose: 'email',
        createdAt: new Date(),
      }),
    )
    const orderUrl = `${base}/order/${encodeURIComponent(order.orderNumber)}?key=${key}`
    return { orderUrl, orderLink: `\n\nView your order: ${orderUrl}` }
  }

  /** The order-placed email, with a link carrying a key minted for this send when the store has a URL. */
  async function sendOrderPlaced(order: Order): Promise<void> {
    await email.sendTransactional({
      template: 'order-placed',
      to: order.email,
      vars: {
        orderNumber: order.orderNumber,
        customerName: order.billingAddress.firstName,
        totalFormatted: formatMoney(order.totalMinor, order.currency),
        ...(storeUrl !== undefined && (await orderLink(storeUrl, order))),
      },
    })
  }

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
    await sendOrderPlaced(order)
    await store.transaction((tx) =>
      processedEventRepo.markProcessed(tx, ORDER_PAID_EMAIL, orderId, new Date()),
    )
  }

  // An admin's resend: once per resend event, never per order, so it sends whatever became of order.paid's email.
  const onConfirmationResendRequested: EventHandler<
    OrderConfirmationResendRequestedV1Payload
  > = async (event) => {
    const { orderId } = event.payload
    const order = await orderRepo.store.read((tx) => orderRepo.findById(tx, orderId))
    if (order === null) {
      logger.warn({ orderId, eventId: event.id }, 'email handler: resent order not found')
      return
    }
    await sendOrderPlaced(order)
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
    EVT_ORDER_CONFIRMATION_RESEND_REQUESTED,
    withIdempotency(
      'email:order-confirmation-resend',
      onConfirmationResendRequested as EventHandler,
      { repo: processedEventRepo, logger },
    ),
    { name: 'email-order-confirmation-resend' },
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
