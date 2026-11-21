import { randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import {
  EVT_CART_ABANDONED,
  EVT_CUSTOMER_CREATED,
  EVT_CUSTOMER_PASSWORD_RESET_REQUESTED,
  EVT_CUSTOMER_REGISTERED_AGAIN,
  EVT_CUSTOMER_VERIFICATION_REQUESTED,
  EVT_ORDER_CONFIRMATION_RESEND_REQUESTED,
  EVT_ORDER_PAID,
  EVT_ORDER_SHIPPED,
  type CartAbandonedV1Payload,
  type CustomerCreatedV1Payload,
  type CustomerPasswordResetRequestedV1Payload,
  type Customer,
  type CustomerRegisteredAgainV1Payload,
  type CustomerVerificationRequestedV1Payload,
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
import {
  ACCOUNT_EXISTS_WINDOW_MS,
  EMAIL_VERIFICATION_TTL_MS,
  hashResetToken,
  PASSWORD_RESET_TTL_MS,
  VERIFICATION_REISSUE_MS,
} from '../../services/auth-service.js'
import { withIdempotency } from '../idempotency.js'
import type { CustomerRepository } from '../../repositories/customer.js'
import type { EmailVerificationTokenRepository } from '../../repositories/email-verification-token.js'
import type { OrderAccessKeyRepository } from '../../repositories/order-access-key.js'
import type { OrderRepository } from '../../repositories/order.js'
import type { PasswordResetTokenRepository } from '../../repositories/password-reset-token.js'
import type { ProcessedEventRepository } from '../../repositories/processed-event.js'

/** The handler name of the order-placed email's records: one per order, whatever number of order.paid it gets. */
const ORDER_PAID_EMAIL = 'email:order-paid'

/** The handler name of the account-exists notice's records: one per account per window. */
const ACCOUNT_EXISTS_EMAIL = 'email:account-exists'

export interface RegisterEmailHandlerDeps {
  eventBus: EventBusAdapter
  email: EmailAdapter
  logger: Logger
  processedEventRepo: ProcessedEventRepository
  orderRepo: OrderRepository
  orderAccessKeyRepo: OrderAccessKeyRepository
  customerRepo: CustomerRepository
  passwordResetTokenRepo: PasswordResetTokenRepository
  emailVerificationTokenRepo: EmailVerificationTokenRepository
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
  const { customerRepo, passwordResetTokenRepo: resetRepo } = deps
  const { emailVerificationTokenRepo: verifyRepo } = deps
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
    // An imported customer was already a customer of the store; the welcome is for one who registered. A sign-up asked
    // to confirm gets the confirmation link as its first mail instead.
    if (event.payload.origin === 'import' || event.payload.verification === 'pending') return
    await email.sendTransactional({
      template: 'welcome',
      to: event.payload.email,
      vars: { customerName: 'there', storeName },
    })
  }

  /**
   * Mints the link's token here, so only its hash is stored and no event holds it. One live link per account: a
   * request while one is live sends nothing. A send that fails takes its link back, so the relay's retry mints anew.
   * Reset mail goes to a suppressed address too: the shopper asked for it, as for a receipt.
   */
  const onPasswordResetRequested: EventHandler<CustomerPasswordResetRequestedV1Payload> = async (
    event,
  ) => {
    const { customerId } = event.payload
    const customer = await customerRepo.store.read((tx) => customerRepo.findById(tx, customerId))
    if (customer === null || !canReceiveMail(customer.email)) return
    if (storeUrl === undefined) {
      logger.warn(
        { customerId, eventId: event.id },
        'email handler: store.url is not set, so no password reset link can be mailed',
      )
      return
    }
    const now = new Date()
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashResetToken(token)
    const minted = await resetRepo.store.transaction(async (tx) => {
      if ((await resetRepo.findLiveForCustomer(tx, customerId, now)) !== null) return false
      await resetRepo.purgeExpired(tx, now)
      await resetRepo.insert(tx, {
        id: uuidv7(),
        customerId,
        tokenHash,
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
        createdAt: now,
      })
      return true
    })
    if (!minted) return
    try {
      await email.sendTransactional({
        template: 'password-reset',
        to: customer.email,
        vars: {
          storeName,
          resetUrl: `${storeUrl}/account/reset-password#token=${token}`,
          expiresMinutes: PASSWORD_RESET_TTL_MS / 60_000,
        },
      })
    } catch (err) {
      await resetRepo.store.transaction((tx) => resetRepo.consume(tx, tokenHash, now))
      throw err
    }
  }

  /**
   * The customer a link or notice goes to, or null when they are gone, not `wanted`, have no address mail reaches, or
   * the store has no URL to link to (logged, naming no address).
   */
  async function mailableCustomer(
    customerId: string,
    eventId: string,
    what: string,
    wanted: (customer: Customer) => boolean = () => true,
  ): Promise<{ customer: Customer; storeUrl: string } | null> {
    const customer = await customerRepo.store.read((tx) => customerRepo.findById(tx, customerId))
    if (customer === null || !wanted(customer) || !canReceiveMail(customer.email)) return null
    if (storeUrl === undefined) {
      logger.warn(
        { customerId, eventId },
        `email handler: store.url is not set, so no ${what} can be mailed`,
      )
      return null
    }
    return { customer, storeUrl }
  }

  /**
   * As the reset link: the token is minted here and only its hash stored; one live link per account, replaced on each
   * send. `if-stale` (a shopper's register or resend) sends nothing while the live link is under 15 minutes old.
   */
  const onVerificationRequested: EventHandler<CustomerVerificationRequestedV1Payload> = async (
    event,
  ) => {
    const { customerId, reissue } = event.payload
    const target = await mailableCustomer(
      customerId,
      event.id,
      'confirmation link',
      (customer) => customer.emailVerification === 'pending',
    )
    if (target === null) return
    const now = new Date()
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashResetToken(token)
    const minted = await verifyRepo.store.transaction(async (tx) => {
      if (reissue === 'if-stale') {
        const live = await verifyRepo.findLiveForCustomer(tx, customerId, now)
        if (live !== null && now.getTime() - live.createdAt.getTime() < VERIFICATION_REISSUE_MS) {
          return false
        }
      }
      await verifyRepo.deleteByCustomer(tx, customerId)
      await verifyRepo.purgeExpired(tx, now)
      await verifyRepo.insert(tx, {
        id: uuidv7(),
        customerId,
        tokenHash,
        expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS),
        createdAt: now,
      })
      return true
    })
    if (!minted) return
    try {
      await email.sendTransactional({
        template: 'verify-email',
        to: target.customer.email,
        vars: {
          storeName,
          verifyUrl: `${target.storeUrl}/account/verify-email#token=${token}`,
          expiresHours: EMAIL_VERIFICATION_TTL_MS / 3_600_000,
        },
      })
    } catch (err) {
      await verifyRepo.store.transaction((tx) => verifyRepo.consume(tx, tokenHash, now))
      throw err
    }
  }

  // At most one notice per account per fixed window. Marked only once sent, so a send that throws is retried.
  const onRegisteredAgain: EventHandler<CustomerRegisteredAgainV1Payload> = async (event) => {
    const { customerId } = event.payload
    const target = await mailableCustomer(customerId, event.id, 'account notice')
    if (target === null) return
    const key = `${customerId}:${Math.floor(Date.now() / ACCOUNT_EXISTS_WINDOW_MS)}`
    const { store } = processedEventRepo
    if (await store.read((tx) => processedEventRepo.seen(tx, ACCOUNT_EXISTS_EMAIL, key))) return
    await email.sendTransactional({
      template: 'account-exists',
      to: target.customer.email,
      vars: {
        storeName,
        signInUrl: `${target.storeUrl}/account/login`,
        forgotUrl: `${target.storeUrl}/account/forgot-password`,
      },
    })
    await store.transaction((tx) =>
      processedEventRepo.markProcessed(tx, ACCOUNT_EXISTS_EMAIL, key, new Date()),
    )
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
    EVT_CUSTOMER_PASSWORD_RESET_REQUESTED,
    withIdempotency('email:password-reset', onPasswordResetRequested as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'email-password-reset' },
  )
  await eventBus.subscribe(
    EVT_CUSTOMER_VERIFICATION_REQUESTED,
    withIdempotency('email:verification', onVerificationRequested as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'email-verification' },
  )
  await eventBus.subscribe(
    EVT_CUSTOMER_REGISTERED_AGAIN,
    withIdempotency('email:registered-again', onRegisteredAgain as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'email-registered-again' },
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
