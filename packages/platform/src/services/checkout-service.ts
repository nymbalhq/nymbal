import { v7 as uuidv7 } from 'uuid'
import {
  CheckoutError,
  EVT_CART_CONVERTED,
  EVT_ORDER_PAID,
  EVT_PAYMENT_CAPTURED,
  NotFoundError,
  type Address,
  type Cart,
  type DocumentStoreAdapter,
  type Logger,
  type OrderLineItem,
  type PaymentsAdapter,
  type PaymentIntent,
} from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
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
  paymentIntent: PaymentIntent
  currency: string
  totalMinor: number
}

export interface CheckoutService {
  beginCheckout(input: BeginCheckoutInput): Promise<BeginCheckoutResult>
  finalize(paymentIntentId: string, paidAmountMinor: number): Promise<{ orderNumber: string }>
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
  documentStore: DocumentStoreAdapter
  currency: string
}

interface DraftMetadata {
  cartToken: string
  reservationIds: string[]
}

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

  return {
    async beginCheckout(input) {
      const cartDoc = await loadValidCart(input.cartToken)
      // Validate items against live stock
      for (const item of cartDoc.items) {
        const v = await repos.variant.findById(item.variantId)
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

      // Reserve inventory
      const reservationIds: string[] = []
      try {
        for (const item of cartDoc.items) {
          const r = await inventory.reserveStock(item.variantId, item.qty, null)
          reservationIds.push(r.reservationId)
        }
      } catch (err) {
        // release anything we managed to reserve
        for (const id of reservationIds) {
          await inventory.releaseReservation(id, 'cancelled').catch(() => undefined)
        }
        /* c8 ignore next 5 -- inventory.reserveStock never throws CheckoutError; guards future adapters */
        throw err instanceof CheckoutError
          ? err
          : new CheckoutError('reservation_failed', 'Inventory reservation failed', {
              cause: err,
            })
      }

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

      // Create draft order (status=pending)
      const orderId = uuidv7()
      const order = await orders.createFromCheckout({
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

      // Create payment intent
      const paymentIntentParams: Parameters<PaymentsAdapter['createPaymentIntent']>[0] = {
        amountMinor: totalMinor,
        currency: cartDoc.currency,
        orderRef: order.id,
        metadata: { orderId: order.id, orderNumber: order.orderNumber },
      }
      if (input.customerId != null) paymentIntentParams.customerId = input.customerId
      const paymentIntent = await payments.createPaymentIntent(paymentIntentParams)
      await repos.order.setPaymentIntent(order.id, paymentIntent.id, new Date())
      // Wire reservations to the order for sweeper context
      for (const id of reservationIds) {
        await repos.inventoryReservation.setOrderRef(id, order.id)
      }
      logger.info({ orderId: order.id, orderNumber: order.orderNumber }, 'checkout started')
      return {
        orderId: order.id,
        paymentIntent,
        currency: cartDoc.currency,
        totalMinor,
      }
    },

    async finalize(paymentIntentId, paidAmountMinor) {
      return store.transaction(async () => {
        // Locate the order by paymentIntentId.
        const all = await repos.order.list({ status: 'pending', limit: 1000 })
        const order = all.find((o) => o.paymentIntentId === paymentIntentId)
        if (!order) {
          throw new CheckoutError('finalize_failed', `No pending order for intent ${paymentIntentId}`)
        }
        const metadata = order.metadata as Partial<DraftMetadata>
        const reservationIds = Array.isArray(metadata.reservationIds)
          ? (metadata.reservationIds as string[])
          : []

        // Commit reservations (permanently decrements stock via stock-adjustment log)
        for (const rid of reservationIds) {
          await inventory.commitReservation(rid, 'system:checkout-finalize')
        }

        // Transition order to confirmed
        const updated = await orders.updateStatus(order.id, 'confirmed', 'system:checkout', 'payment captured')

        // Bump customer stats
        if (updated.customerId) {
          await repos.customer.incrementStats(updated.customerId, 1, updated.totalMinor, new Date())
        }

        // Emit payment.captured + order.paid + cart.converted
        await publisher.publish(EVT_PAYMENT_CAPTURED, {
          paymentId: paymentIntentId,
          orderId: updated.id,
          amountMinor: paidAmountMinor,
          currency: updated.currency,
        })
        await publisher.publish(EVT_ORDER_PAID, {
          orderId: updated.id,
          paymentIntentId,
          amountMinor: paidAmountMinor,
          currency: updated.currency,
        })
        if (metadata.cartToken) {
          await cart.clear(metadata.cartToken)
          await publisher.publish(EVT_CART_CONVERTED, {
            cartId: metadata.cartToken,
            orderId: updated.id,
          })
        }
        logger.info({ orderId: updated.id, orderNumber: updated.orderNumber }, 'checkout finalized')
        return { orderNumber: updated.orderNumber }
      })
    },

    async cancel(orderId, reason) {
      const order = await repos.order.findById(orderId)
      if (!order) throw new NotFoundError('order', orderId)
      const metadata = order.metadata as Partial<DraftMetadata>
      const reservationIds = Array.isArray(metadata.reservationIds)
        ? (metadata.reservationIds as string[])
        : []
      for (const rid of reservationIds) {
        await inventory.releaseReservation(rid, 'cancelled').catch(() => undefined)
      }
      await orders.cancel(orderId, reason, 'system:checkout-cancel')
    },
  }
}
