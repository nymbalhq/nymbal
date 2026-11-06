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
import { trackingUrl } from '../../tracking-url.js'
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
  /** How long the email's order key opens the order on its own; 30 days when not given. */
  keyLifetimeMs?: number
}

const DEFAULT_EMAIL_KEY_LIFETIME_MS = 30 * 24 * 3_600_000

/**
 * Whether mail to the order's address can arrive: not empty, and not under `nymbal.local`, where the importer puts the
 * placeholders for addresses it does not have. Other `.local` domains are real on a shop's own network.
 */
function canReceiveMail(address: string): boolean {
  const trimmed = address.trim()
  if (trimmed === '') return false
  const domain = trimmed.slice(trimmed.lastIndexOf('@') + 1).toLowerCase()
  return domain !== 'nymbal.local' && !domain.endsWith('.nymbal.local')
}

/** The greeting's name: the billing first name, or "there" when it has no character to show. */
function customerName(order: Order): string {
  return order.billingAddress.firstName.trim() || 'there'
}

/** One line per order line, in order; the template has no loops, so the list is passed formatted. */
function itemsList(order: Order): string {
  return order.lineItems
    .map((item) => {
      const variant = item.variantName.trim() === '' ? '' : ` (${item.variantName})`
      return `${item.qty} x ${item.productName}${variant}`
    })
    .join('\n')
}

export async function registerEmailHandler(deps: RegisterEmailHandlerDeps): Promise<void> {
  const { eventBus, email, logger, processedEventRepo, orderRepo, orderAccessKeyRepo } = deps
  const { storeName, storeUrl } = deps
  const keyLifetimeMs = deps.keyLifetimeMs ?? DEFAULT_EMAIL_KEY_LIFETIME_MS

  /**
   * The order's page: a customer's in their account, with no key; a guest's with a key of the email's own, since only
   * the hash of the checkout's key is stored, so the handler never has it.
   */
  async function orderLink(
    base: string,
    order: Order,
  ): Promise<{ orderUrl: string; orderLink: string }> {
    const number = encodeURIComponent(order.orderNumber)
    let orderUrl = `${base}/account/orders/${number}`
    if (order.customerId === null) {
      const { key, hash } = mintOrderKey()
      const createdAt = new Date()
      await orderAccessKeyRepo.store.transaction((tx) =>
        orderAccessKeyRepo.insert(tx, {
          id: uuidv7(),
          orderId: order.id,
          keyHash: hash,
          purpose: 'email',
          createdAt,
          expiresAt: new Date(createdAt.getTime() + keyLifetimeMs),
        }),
      )
      orderUrl = `${base}/order/${number}?key=${key}`
    }
    return { orderUrl, orderLink: `\n\nView your order: ${orderUrl}` }
  }

  /** Logs a send skipped for an address no mail reaches; the address itself is never logged. */
  function skippedNoAddress(order: Order, eventId: string): void {
    logger.info({ orderId: order.id, eventId }, 'email handler: order has no deliverable address')
  }

  /** The order-placed email, with a link carrying a key minted for this send when the store has a URL. */
  async function sendOrderPlaced(order: Order, eventId: string): Promise<void> {
    if (!canReceiveMail(order.email)) {
      skippedNoAddress(order, eventId)
      return
    }
    await email.sendTransactional({
      template: 'order-placed',
      to: order.email,
      vars: {
        orderNumber: order.orderNumber,
        customerName: customerName(order),
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
    await sendOrderPlaced(order, event.id)
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
    await sendOrderPlaced(order, event.id)
  }

  // Keyed per event: an order ships once, so one order.shipped per order and one email per shipment.
  const onOrderShipped: EventHandler<OrderShippedV1Payload> = async (event) => {
    const { orderId, carrier, trackingNumber } = event.payload
    const order = await orderRepo.store.read((tx) => orderRepo.findById(tx, orderId))
    if (order === null) {
      logger.warn({ orderId, eventId: event.id }, 'email handler: shipped order not found')
      return
    }
    if (!canReceiveMail(order.email)) {
      skippedNoAddress(order, event.id)
      return
    }
    const tracking = trackingUrl(carrier, trackingNumber)
    await email.sendTransactional({
      template: 'order-shipped',
      to: order.email,
      vars: {
        orderNumber: order.orderNumber,
        customerName: customerName(order),
        carrier,
        trackingNumber,
        itemsList: itemsList(order),
        ...(tracking !== null && {
          trackingUrl: tracking,
          trackingLink: `\n\nTrack your parcel: ${tracking}`,
        }),
        ...(storeUrl !== undefined && (await orderLink(storeUrl, order))),
      },
    })
  }

  const onCustomerCreated: EventHandler<CustomerCreatedV1Payload> = async (event) => {
    // An imported customer was already a customer of the store; the welcome is for one who registered.
    if (event.payload.origin === 'import') return
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
