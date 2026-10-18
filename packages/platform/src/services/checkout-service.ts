import { v7 as uuidv7 } from 'uuid'
import {
  CheckoutError,
  EVT_CART_CONVERTED,
  EVT_CART_UPDATED,
  EVT_ORDER_PAID,
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_FAILED,
  NotFoundError,
  type Address,
  type Cart,
  type Logger,
  type Order,
  type OrderLineItem,
  type PaymentsAdapter,
  type PaymentIntent,
} from '@nymbalhq/types'
import type { CommandStore, Tx } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'
import type { InventoryService } from './inventory-service.js'
import type { OrderService } from './order-service.js'
import type { CartService } from './cart-service.js'

export interface BeginCheckoutInput {
  cartToken: string
  customerId?: string | null
  email: string
  billingAddress: Address
  shippingAddress: Address
  notes?: string
}

export interface BeginCheckoutResult {
  orderId: string
  orderNumber: string
  paymentIntent: PaymentIntent
  currency: string
  totalMinor: number
}

/** What the payment provider captured. */
export interface CapturedPayment {
  amountMinor: number
  /** ISO 4217, in any case. */
  currency: string
}

export interface FinalizeResult {
  /** Null when no order has the payment intent. */
  orderNumber: string | null
  /** True when the order is confirmed: by this call, or already for this intent. */
  finalized: boolean
  /** Why the captured payment did not confirm the order; recorded as payment.failed. */
  reason?: string
}

export interface CheckoutService {
  beginCheckout(input: BeginCheckoutInput): Promise<BeginCheckoutResult>
  /**
   * Confirms the order a captured payment is for, or records why not (a payment.failed with the reason and, when
   * there is an order, a history note) and leaves the order as it was. Joins the caller's transaction.
   */
  finalize(paymentIntentId: string, paid: CapturedPayment): Promise<FinalizeResult>
  cancel(orderId: string, reason: string): Promise<void>
}

export interface CreateCheckoutServiceDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
  cart: CartService
  orders: OrderService
  inventory: InventoryService
  payments: PaymentsAdapter
  currency: string
}

interface DraftMetadata {
  cartToken: string
  reservationIds: string[]
}

/** A line whose released reservation cannot be re-taken: another order has the stock now. */
class StockUnavailable extends Error {
  constructor(readonly variantId: string) {
    super(`stock unavailable for variant ${variantId}`)
  }
}

/** The conditional confirm found the order no longer pending: a concurrent writer moved it first. */
class NoLongerPending extends Error {}

const FINALIZE_ACTOR = 'system:checkout-finalize'

export function createCheckoutService(deps: CreateCheckoutServiceDeps): CheckoutService {
  const { store, repos, publisher, logger, cart, orders, inventory, payments, currency } = deps

  async function loadValidCart(token: string): Promise<Cart> {
    const c = await cart.get(token)
    if (!c) throw new NotFoundError('cart', token)
    if (!c.items.length) {
      throw new CheckoutError('cart_empty', 'Cart has no items')
    }
    if (c.currency !== currency) {
      throw new CheckoutError(
        'cart_empty',
        `Cart currency ${c.currency} does not match store currency ${currency}`,
      )
    }
    return c
  }

  /** No order for the intent, or an order that is no longer pending. */
  async function settled(
    tx: Tx,
    paymentIntentId: string,
    order: Order | null,
  ): Promise<FinalizeResult> {
    if (order === null) return recordOutcome(tx, paymentIntentId, null, 'no_order')
    // Idempotent on the order: a second event id or a concurrent delivery for a confirmed order changes nothing.
    if (order.status === 'confirmed') return { orderNumber: order.orderNumber, finalized: true }
    return recordOutcome(tx, paymentIntentId, order, `order_not_pending: ${order.status}`)
  }

  /** A captured payment that does not confirm its order: recorded, and nothing else changes. */
  async function recordOutcome(
    tx: Tx,
    paymentIntentId: string,
    order: Order | null,
    reason: string,
  ): Promise<FinalizeResult> {
    await publisher.publish(EVT_PAYMENT_FAILED, {
      paymentId: paymentIntentId,
      orderId: order?.id ?? '',
      reason,
    })
    if (order !== null) {
      await repos.orderHistory.append(tx, {
        id: uuidv7(),
        orderId: order.id,
        fromStatus: order.status,
        toStatus: order.status,
        actor: FINALIZE_ACTOR,
        note: `captured payment not applied: ${reason}`,
        timestamp: new Date(),
      })
    }
    logger.warn({ paymentIntentId, orderId: order?.id, reason }, 'captured payment not applied')
    return { orderNumber: order?.orderNumber ?? null, finalized: false, reason }
  }

  /**
   * The reservation for line `index`, held or re-taken. The sweeper releases a reservation after its TTL while the
   * order stays pending; a late payment takes the line's stock again with the same conditional decrement.
   */
  async function reservationFor(
    tx: Tx,
    order: Order,
    reservationId: string,
    index: number,
  ): Promise<string> {
    const held = await repos.inventoryReservation.findById(tx, reservationId)
    if (held !== null) return reservationId
    // Checkout reserves one line at a time, in line order.
    const line = order.lineItems[index]
    if (line === undefined) {
      throw new CheckoutError(
        'finalize_failed',
        `Order ${order.id} has no line for reservation ${reservationId}`,
      )
    }
    // A variant deleted since checkout has no stock to re-take.
    const retaken = await inventory
      .tryReserveStock(line.variantId, line.qty, order.id)
      .catch((err: unknown) => {
        if (err instanceof NotFoundError) return null
        throw err
      })
    if (retaken === null) throw new StockUnavailable(line.variantId)
    return retaken.reservationId
  }

  async function confirm(
    tx: Tx,
    paymentIntentId: string,
    paid: CapturedPayment,
    order: Order,
  ): Promise<FinalizeResult> {
    const metadata = order.metadata as Partial<DraftMetadata>
    const reservationIds = Array.isArray(metadata.reservationIds)
      ? (metadata.reservationIds as string[])
      : []
    // Committing makes the reservation's decrement permanent, with its stock-adjustment row.
    for (const [index, reservationId] of reservationIds.entries()) {
      const reservation = await reservationFor(tx, order, reservationId, index)
      await inventory.commitReservation(reservation, FINALIZE_ACTOR)
    }

    const now = new Date()
    if (!(await repos.order.setStatusIf(tx, order.id, 'pending', 'confirmed', now))) {
      throw new NoLongerPending()
    }
    await repos.orderHistory.append(tx, {
      id: uuidv7(),
      orderId: order.id,
      fromStatus: 'pending',
      toStatus: 'confirmed',
      actor: 'system:checkout',
      note: 'payment captured',
      timestamp: now,
    })
    if (order.customerId) {
      await repos.customer.incrementStats(tx, order.customerId, 1, order.totalMinor, now)
    }

    await publisher.publish(EVT_PAYMENT_CAPTURED, {
      paymentId: paymentIntentId,
      orderId: order.id,
      amountMinor: paid.amountMinor,
      currency: order.currency,
    })
    await publisher.publish(EVT_ORDER_PAID, {
      orderId: order.id,
      paymentIntentId,
      amountMinor: paid.amountMinor,
      currency: order.currency,
    })

    // The cart empties in the same commit as the payment it became. A cart that expired or was swept while the
    // shopper paid is not a reason to refuse a paid order; cart.converted still records where the order came from.
    const cartToken = metadata.cartToken
    if (cartToken) {
      if (await repos.cart.clearIfLive(tx, cartToken, now)) {
        await publisher.publish(EVT_CART_UPDATED, {
          cartId: cartToken,
          itemCount: 0,
          totalMinor: 0,
        })
      }
      await publisher.publish(EVT_CART_CONVERTED, {
        cartId: cartToken,
        orderId: order.id,
      })
    }
    logger.info({ orderId: order.id, orderNumber: order.orderNumber }, 'checkout finalized')
    return { orderNumber: order.orderNumber, finalized: true }
  }

  return {
    async beginCheckout(input) {
      const cartDoc = await loadValidCart(input.cartToken)
      // A fast, readable refusal; the conditional decrement inside the transaction is what holds under concurrency.
      await store.read(async (tx) => {
        for (const item of cartDoc.items) {
          const v = await repos.variant.findById(tx, item.variantId)
          if (!v) {
            throw new CheckoutError('variant_missing', `Variant missing: ${item.variantId}`)
          }
          if (v.stock < item.qty) {
            throw new CheckoutError(
              'out_of_stock',
              `Insufficient stock for ${item.variantName}: available ${v.stock}, requested ${item.qty}`,
            )
          }
        }
      })

      // Build line items snapshot
      const lineItems: OrderLineItem[] = cartDoc.items.map((item) => ({
        variantId: item.variantId,
        productId: item.productId,
        productName: item.productName,
        variantName: item.variantName,
        sku: '',
        qty: item.qty,
        unitPriceMinor: item.priceMinor,
        lineSubtotalMinor: item.priceMinor * item.qty,
        lineTaxMinor: 0,
        lineTotalMinor: item.priceMinor * item.qty,
        imageUrl: item.imageUrl,
      }))
      const subtotalMinor = cartDoc.subtotalMinor
      const totalMinor = subtotalMinor
      const orderId = uuidv7()

      // The reservations and the draft order (status=pending) commit together or not at all.
      const order = await store.transaction(async () => {
        const reservationIds: string[] = []
        for (const item of cartDoc.items) {
          try {
            const r = await inventory.reserveStock(item.variantId, item.qty, orderId)
            reservationIds.push(r.reservationId)
          } catch (err) {
            /* c8 ignore next -- inventory.reserveStock never throws CheckoutError; guards future adapters */
            if (err instanceof CheckoutError) throw err
            throw new CheckoutError('reservation_failed', 'Inventory reservation failed', {
              cause: err,
            })
          }
        }
        return orders.createFromCheckout({
          orderId,
          customerId: input.customerId ?? null,
          email: input.email,
          billingAddress: input.billingAddress,
          shippingAddress: input.shippingAddress,
          lineItems,
          subtotalMinor,
          taxTotalMinor: 0,
          shippingTotalMinor: 0,
          discountTotalMinor: 0,
          totalMinor,
          currency: cartDoc.currency,
          ...(input.notes !== undefined && { notes: input.notes }),
          metadata: { cartToken: cartDoc.token, reservationIds } satisfies DraftMetadata,
        })
      })

      // Create payment intent: a call to the payments adapter, so outside the transaction.
      const paymentIntentParams: Parameters<PaymentsAdapter['createPaymentIntent']>[0] = {
        amountMinor: totalMinor,
        currency: cartDoc.currency,
        orderRef: order.id,
        metadata: { orderId: order.id, orderNumber: order.orderNumber },
      }
      if (input.customerId != null) paymentIntentParams.customerId = input.customerId
      const paymentIntent = await payments.createPaymentIntent(paymentIntentParams)
      await store.transaction((tx) =>
        repos.order.setPaymentIntent(tx, order.id, paymentIntent.id, new Date()),
      )
      logger.info({ orderId: order.id, orderNumber: order.orderNumber }, 'checkout started')
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentIntent,
        currency: cartDoc.currency,
        totalMinor,
      }
    },

    async finalize(paymentIntentId, paid) {
      return store.transaction(async (tx) => {
        const outcome = (order: Order | null, reason: string) =>
          recordOutcome(tx, paymentIntentId, order, reason)
        const order = await repos.order.findByPaymentIntentId(tx, paymentIntentId)
        if (order === null || order.status !== 'pending') return settled(tx, paymentIntentId, order)
        // Amount and currency: an underpayment, overpayment or other currency is an outcome, never a confirmation.
        if (
          paid.amountMinor !== order.totalMinor ||
          paid.currency.toUpperCase() !== order.currency.toUpperCase()
        ) {
          return outcome(
            order,
            `amount_mismatch: paid ${paid.amountMinor} ${paid.currency.toUpperCase()}, ` +
              `due ${order.totalMinor} ${order.currency.toUpperCase()}`,
          )
        }
        try {
          // Behind a savepoint: when stock is gone or the order moved first, whatever the earlier lines took is undone.
          return await store.savepoint(() => confirm(tx, paymentIntentId, paid, order))
        } catch (err) {
          if (err instanceof StockUnavailable) {
            // A concurrent writer may have confirmed the order with the units this re-take wanted.
            const current = await repos.order.findById(tx, order.id)
            if (current?.status !== 'pending') return settled(tx, paymentIntentId, current)
            return outcome(current, `stock_unavailable: ${err.variantId}`)
          }
          if (!(err instanceof NoLongerPending)) throw err
        }
        // Another delivery (or an admin) moved the order between the read and the write.
        return settled(tx, paymentIntentId, await repos.order.findById(tx, order.id))
      })
    },

    async cancel(orderId, reason) {
      await store.transaction(async (tx) => {
        const order = await repos.order.findById(tx, orderId)
        if (!order) throw new NotFoundError('order', orderId)
        const metadata = order.metadata as Partial<DraftMetadata>
        const reservationIds = Array.isArray(metadata.reservationIds)
          ? (metadata.reservationIds as string[])
          : []
        // A reservation already released or committed is a no-op here.
        for (const rid of reservationIds) {
          await inventory.releaseReservation(rid, 'cancelled')
        }
        await orders.cancel(orderId, reason, 'system:checkout-cancel')
      })
    },
  }
}
