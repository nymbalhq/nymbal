import { v7 as uuidv7 } from 'uuid'
import {
  CheckoutError,
  EVT_CART_CONVERTED,
  EVT_CART_UPDATED,
  EVT_ORDER_PAID,
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_FAILED,
  NotFoundError,
  PaymentError,
  type Address,
  type Cart,
  type CheckoutPayment,
  type Logger,
  type Order,
  type OrderLineItem,
  type OrderStatus,
  type PaymentsAdapter,
  type PaymentIntent,
  type PaymentStatus,
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
  /** The order's status as the checkout answers. */
  orderStatus: OrderStatus
  payment: CheckoutPayment
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
const CANCEL_ACTOR = 'system:checkout-cancel'

/** Cancels of a changed cart's earlier intent one checkout makes before it gives up to a busier writer. */
const SUPERSEDE_ATTEMPTS = 3

/** What one pass under the cart lock decided. */
type Placement =
  | { kind: 'placed'; order: Order }
  | { kind: 'existing'; order: Order & { paymentIntentId: string } }
  | { kind: 'cancel-first'; order: Order & { paymentIntentId: string } }

/** The shopper's view of an intent the provider has just made. */
function outcomeOf(status: PaymentStatus): CheckoutPayment['status'] {
  if (status === 'succeeded') return 'succeeded'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  return 'requires_action'
}

/** The pending order is for exactly this cart: the same lines, quantities, prices and total. */
function sameLines(order: Order, cart: Cart): boolean {
  if (order.totalMinor !== cart.subtotalMinor || order.currency !== cart.currency) return false
  if (order.lineItems.length !== cart.items.length) return false
  return cart.items.every((item, i) => {
    const line = order.lineItems[i]
    return (
      line?.variantId === item.variantId &&
      line.qty === item.qty &&
      line.unitPriceMinor === item.priceMinor
    )
  })
}

export function createCheckoutService(deps: CreateCheckoutServiceDeps): CheckoutService {
  const { store, repos, publisher, logger, cart, orders, inventory, payments, currency } = deps

  /** An empty cart's refusal, naming the order the cart became when it became one. */
  async function cartEmpty(token: string): Promise<CheckoutError> {
    const converted = await store.read((tx) => repos.order.findLastConvertedByCartToken(tx, token))
    return new CheckoutError(
      'cart_empty',
      'Cart has no items',
      converted ? { context: { orderNumber: converted.orderNumber } } : {},
    )
  }

  async function loadValidCart(token: string): Promise<Cart> {
    const c = await cart.get(token)
    if (!c) throw new NotFoundError('cart', token)
    if (!c.items.length) throw await cartEmpty(token)
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
    if (order.status === 'cancelled') {
      // Money never stays without an order: a capture for a cancelled order goes back in full. A refund that fails
      // throws, so the delivery is not recorded and the provider sends it again.
      await payments.refund(paymentIntentId)
      return recordOutcome(tx, paymentIntentId, order, 'order_cancelled_refunded')
    }
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

  /** Releases a pending order's reservations and cancels it. Joins the caller's transaction. */
  async function cancelDraft(orderId: string, reason: string): Promise<void> {
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
      await orders.cancel(orderId, reason, CANCEL_ACTOR)
    })
  }

  /** A fast, readable refusal; the conditional decrement when reserving is what holds under concurrency. */
  async function checkStock(tx: Tx, cartDoc: Cart): Promise<void> {
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
  }

  /**
   * T1, under the cart's row lock: the cart's pending order is returned when it is for this cart, superseded when the
   * cart changed and its intent is cancelled (`cancelled`), or else the stock is reserved and a new pending order
   * created with no intent yet. Nothing is written unless an order is created.
   */
  async function place(
    tx: Tx,
    input: BeginCheckoutInput,
    cancelled: ReadonlySet<string>,
  ): Promise<Placement> {
    // Read again under the lock: the lines to order are the ones no concurrent cart command can change now.
    const cartDoc = await repos.cart.lock(tx, input.cartToken)
    if (cartDoc === null) throw new NotFoundError('cart', input.cartToken)
    if (!cartDoc.items.length) throw await cartEmpty(input.cartToken)

    const pending = await repos.order.findPendingByCartToken(tx, input.cartToken)
    if (pending !== null) {
      const { paymentIntentId } = pending
      // Another checkout of this cart is between its order and its intent; a second intent is never made.
      if (paymentIntentId === null) {
        throw new CheckoutError('in_progress', 'A checkout for this cart is already in progress')
      }
      if (sameLines(pending, cartDoc))
        return { kind: 'existing', order: { ...pending, paymentIntentId } }
      if (!cancelled.has(paymentIntentId)) {
        return { kind: 'cancel-first', order: { ...pending, paymentIntentId } }
      }
      await cancelDraft(pending.id, 'superseded: the cart changed')
    }

    await checkStock(tx, cartDoc)
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
    const orderId = uuidv7()
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
    const order = await orders.createFromCheckout({
      orderId,
      customerId: input.customerId ?? null,
      email: input.email,
      billingAddress: input.billingAddress,
      shippingAddress: input.shippingAddress,
      lineItems,
      subtotalMinor: cartDoc.subtotalMinor,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: cartDoc.subtotalMinor,
      currency: cartDoc.currency,
      ...(input.notes !== undefined && { notes: input.notes }),
      metadata: { cartToken: cartDoc.token, reservationIds } satisfies DraftMetadata,
      cartToken: cartDoc.token,
    })
    return { kind: 'placed', order }
  }

  /** The cart's pending order, answered again with its intent as the provider holds it now. */
  async function answerExisting(
    order: Order & { paymentIntentId: string },
  ): Promise<BeginCheckoutResult> {
    const paymentIntent = await payments.getPaymentIntent(order.paymentIntentId)
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentIntent,
      currency: order.currency,
      totalMinor: order.totalMinor,
      orderStatus: order.status,
      payment: { status: 'requires_action' },
    }
  }

  /** The provider's cancel of a superseded order's intent, outside any transaction. */
  async function cancelIntent(order: Order & { paymentIntentId: string }): Promise<void> {
    try {
      await payments.cancelPaymentIntent(order.paymentIntentId)
    } catch (err) {
      if (!(err instanceof PaymentError && err.code === 'payment.cancel_refused')) throw err
      throw new CheckoutError(
        'payment_in_progress',
        `The payment for order ${order.orderNumber} is already under way`,
        { cause: err, context: { orderNumber: order.orderNumber } },
      )
    }
  }

  /**
   * The intent, outside any transaction, then T2 under the cart lock: the intent is stored and, by its status, the order
   * is confirmed (in the same transaction), cancelled with its stock released, or left pending for the provider.
   */
  async function pay(input: BeginCheckoutInput, order: Order): Promise<BeginCheckoutResult> {
    const params: Parameters<PaymentsAdapter['createPaymentIntent']>[0] = {
      amountMinor: order.totalMinor,
      currency: order.currency,
      orderRef: order.id,
      receiptEmail: input.email,
      metadata: { orderId: order.id, orderNumber: order.orderNumber },
    }
    if (input.customerId != null) params.customerId = input.customerId
    let intent: PaymentIntent
    try {
      intent = await payments.createPaymentIntent(params)
    } catch (err) {
      // An order with no intent would hold the cart at checkout.in_progress for good.
      await cancelDraft(order.id, 'payment intent not created')
      throw err
    }

    return store.transaction(async (tx) => {
      await repos.cart.lock(tx, input.cartToken)
      await repos.order.setPaymentIntent(tx, order.id, intent.id, new Date())
      let payment: CheckoutPayment
      const outcome = outcomeOf(intent.status)
      if (outcome === 'succeeded') {
        const done = await finalize(intent.id, {
          amountMinor: intent.amountMinor,
          currency: intent.currency,
        })
        payment = done.finalized
          ? { status: 'succeeded' }
          : { status: 'failed', reason: done.reason ?? 'not_confirmed' }
      } else if (outcome === 'failed') {
        const reason = `payment_${intent.status}`
        await cancelDraft(order.id, reason)
        await publisher.publish(EVT_PAYMENT_FAILED, {
          paymentId: intent.id,
          orderId: order.id,
          reason,
        })
        payment = { status: 'failed', reason }
      } else {
        payment = { status: 'requires_action' }
      }
      const current = await repos.order.findById(tx, order.id)
      logger.info(
        { orderId: order.id, orderNumber: order.orderNumber, payment: payment.status },
        'checkout started',
      )
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentIntent: intent,
        currency: order.currency,
        totalMinor: order.totalMinor,
        orderStatus: current?.status ?? order.status,
        payment,
      }
    })
  }

  async function finalize(paymentIntentId: string, paid: CapturedPayment): Promise<FinalizeResult> {
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
  }

  return {
    async beginCheckout(input) {
      await loadValidCart(input.cartToken)
      // Intents this checkout has cancelled with the provider, so a pending order holding one may be superseded.
      const cancelled = new Set<string>()
      for (let attempt = 0; ; attempt += 1) {
        const placement = await store.transaction((tx) => place(tx, input, cancelled))
        if (placement.kind === 'placed') return pay(input, placement.order)
        if (placement.kind === 'existing') return answerExisting(placement.order)
        if (attempt === SUPERSEDE_ATTEMPTS) {
          throw new CheckoutError('in_progress', 'A checkout for this cart is already in progress')
        }
        await cancelIntent(placement.order)
        cancelled.add(placement.order.paymentIntentId)
      }
    },

    finalize,

    async cancel(orderId, reason) {
      await cancelDraft(orderId, reason)
    },
  }
}
