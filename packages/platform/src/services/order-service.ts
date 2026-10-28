import { v7 as uuidv7 } from 'uuid'
import {
  EVT_ORDER_CANCELLED,
  EVT_ORDER_CONFIRMATION_RESEND_REQUESTED,
  EVT_ORDER_DELIVERED,
  EVT_ORDER_PLACED,
  EVT_ORDER_SHIPPED,
  EVT_ORDER_STATUS_CHANGED,
  NotFoundError,
  OrderConflictError,
  StatusTransitionError,
  ValidationError,
  assertOrderTransition,
  type Address,
  type CaptureMethod,
  type Logger,
  type Order,
  type OrderLineItem,
  type OrderStatus,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { CommandStore, ReadTx, Tx } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'
import { hashOrderKey, isOrderKey } from '../order-access-key.js'

export interface OrderCreateDraftInput {
  orderId: string
  customerId: string | null
  email: string
  billingAddress: Address
  shippingAddress: Address
  lineItems: OrderLineItem[]
  subtotalMinor: number
  taxTotalMinor: number
  shippingTotalMinor: number
  discountTotalMinor: number
  totalMinor: number
  currency: string
  notes?: string
  metadata?: Record<string, unknown>
  paymentIntentId?: string | null
  cartToken?: string | null
}

export interface OrderImportInput extends OrderCreateDraftInput {
  orderNumber: string
  status: OrderStatus
  createdAt: Date
  /** What the imported order was paid, taken as captured when it was placed; nothing when absent. */
  capturedMinor?: number
  refundedMinor?: number
  captureMethod?: CaptureMethod | null
}

export interface OrderService {
  createFromCheckout(input: OrderCreateDraftInput): Promise<Order>
  importOrder(input: OrderImportInput): Promise<Order>
  getById(id: string): Promise<Order>
  getByOrderNumber(orderNumber: string): Promise<Order>
  listByCustomer(customerId: string): Promise<Order[]>
  /** Whether `key` opens the order: one of its own keys, well formed. Another order's key opens nothing. */
  keyOpens(orderId: string, key: string): Promise<boolean>
  updateStatus(id: string, toStatus: OrderStatus, actor: string, note?: string): Promise<Order>
  markShipped(id: string, trackingNumber: string, carrier: string, actor: string): Promise<Order>
  markDelivered(id: string, actor: string): Promise<Order>
  /** Refuses with `order.paid` once anything is captured: a paid order is refunded, never cancelled. */
  cancel(id: string, reason: string, actor: string): Promise<Order>
  /**
   * Asks for the order's confirmation email again; the email handler sends it. Refuses with `order.unpaid` for an
   * order no confirmation is due for (pending, or cancelled and so never paid). Changes nothing on the order.
   */
  resendConfirmation(id: string): Promise<Order>
}

/** A cancelled order was never paid (`cancel` refuses once anything is captured), so it has no confirmation either. */
const NO_CONFIRMATION_DUE: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['pending', 'cancelled'])

export interface CreateOrderServiceDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
  orderNumberPrefix: string
  orderNumberStart: number
}

export function createOrderService(deps: CreateOrderServiceDeps): OrderService {
  const { store, repos, publisher } = deps

  async function requireOrder(tx: ReadTx, id: string): Promise<Order> {
    const order = await repos.order.findById(tx, id)
    if (!order) throw new NotFoundError('order', id)
    return order
  }

  async function doTransition(
    tx: Tx,
    order: Order,
    toStatus: OrderStatus,
    actor: string,
    note: string,
  ): Promise<Order> {
    assertOrderTransition(order.status, toStatus)
    const now = new Date()
    await repos.order.setStatus(tx, order.id, toStatus, now)
    await repos.orderHistory.append(tx, {
      id: uuidv7(),
      orderId: order.id,
      fromStatus: order.status,
      toStatus,
      actor,
      note,
      timestamp: now,
    })
    return requireOrder(tx, order.id)
  }

  return {
    async createFromCheckout(input) {
      return store.transaction(async (tx) => {
        audit.note('order.place', [{ type: 'order', id: input.orderId }])
        const sequence = await repos.orderSequence.nextSequence(tx, deps.orderNumberStart)
        const orderNumber = `${deps.orderNumberPrefix}-${sequence + 1}`
        const now = new Date()
        await repos.order.insert(tx, {
          id: input.orderId,
          orderNumber,
          sequence,
          customerId: input.customerId,
          status: 'pending',
          email: input.email,
          billingAddress: input.billingAddress,
          shippingAddress: input.shippingAddress,
          lineItems: input.lineItems,
          subtotalMinor: input.subtotalMinor,
          taxTotalMinor: input.taxTotalMinor,
          shippingTotalMinor: input.shippingTotalMinor,
          discountTotalMinor: input.discountTotalMinor,
          totalMinor: input.totalMinor,
          currency: input.currency,
          notes: input.notes ?? '',
          metadata: input.metadata ?? {},
          paymentIntentId: input.paymentIntentId ?? null,
          cartToken: input.cartToken ?? null,
          createdAt: now,
          updatedAt: now,
        })
        await repos.orderHistory.append(tx, {
          id: uuidv7(),
          orderId: input.orderId,
          fromStatus: null,
          toStatus: 'pending',
          actor: 'system:checkout',
          note: 'order draft created',
          timestamp: now,
        })
        const fresh = await requireOrder(tx, input.orderId)
        await publisher.publish(EVT_ORDER_PLACED, { order: fresh })
        return fresh
      })
    },

    async getById(id) {
      return store.read((tx) => requireOrder(tx, id))
    },
    async getByOrderNumber(orderNumber) {
      const order = await store.read((tx) => repos.order.findByOrderNumber(tx, orderNumber))
      if (!order) throw new NotFoundError('order', orderNumber)
      return order
    },
    async listByCustomer(customerId) {
      return store.read((tx) => repos.order.listByCustomer(tx, customerId))
    },
    async keyOpens(orderId, key) {
      if (!isOrderKey(key)) return false
      return store.read((tx) => repos.orderAccessKey.opens(tx, orderId, hashOrderKey(key)))
    },
    async updateStatus(id, toStatus, actor, note = '') {
      return store.transaction(async (tx) => {
        audit.note('order.updateStatus', [{ type: 'order', id }])
        const order = await requireOrder(tx, id)
        const fresh = await doTransition(tx, order, toStatus, actor, note)
        await publisher.publish(EVT_ORDER_STATUS_CHANGED, {
          orderId: fresh.id,
          from: order.status,
          to: fresh.status,
        })
        return fresh
      })
    },
    async markShipped(id, trackingNumber, carrier, actor) {
      return store.transaction(async (tx) => {
        audit.note('order.ship', [{ type: 'order', id }])
        const order = await requireOrder(tx, id)
        const fresh = await doTransition(
          tx,
          order,
          'shipped',
          actor,
          `Shipped via ${carrier}: ${trackingNumber}`,
        )
        await publisher.publish(EVT_ORDER_SHIPPED, {
          orderId: fresh.id,
          trackingNumber,
          carrier,
        })
        return fresh
      })
    },
    async markDelivered(id, actor) {
      return store.transaction(async (tx) => {
        audit.note('order.markDelivered', [{ type: 'order', id }])
        const order = await requireOrder(tx, id)
        const fresh = await doTransition(tx, order, 'delivered', actor, 'Delivered')
        await publisher.publish(EVT_ORDER_DELIVERED, { orderId: fresh.id })
        return fresh
      })
    },
    async cancel(id, reason, actor) {
      return store.transaction(async (tx) => {
        audit.note('order.cancel', [{ type: 'order', id }])
        // Under the row lock no confirm commits between the paid check and the write.
        const order = await repos.order.lock(tx, id)
        if (!order) throw new NotFoundError('order', id)
        if (order.capturedMinor > 0) {
          throw new OrderConflictError(
            'order.paid',
            `Order ${order.orderNumber} is paid: refund it instead of cancelling`,
          )
        }
        assertOrderTransition(order.status, 'cancelled')
        const now = new Date()
        if (!(await repos.order.setStatusIf(tx, order.id, order.status, 'cancelled', now))) {
          const current = await requireOrder(tx, order.id)
          throw new StatusTransitionError('order', current.status, 'cancelled')
        }
        await repos.orderHistory.append(tx, {
          id: uuidv7(),
          orderId: order.id,
          fromStatus: order.status,
          toStatus: 'cancelled',
          actor,
          note: reason,
          timestamp: now,
        })
        const fresh = await requireOrder(tx, order.id)
        await publisher.publish(EVT_ORDER_CANCELLED, { orderId: fresh.id, reason })
        return fresh
      })
    },
    async resendConfirmation(id) {
      return store.transaction(async (tx) => {
        audit.note('order.resendConfirmation', [{ type: 'order', id }])
        const order = await requireOrder(tx, id)
        if (NO_CONFIRMATION_DUE.has(order.status)) {
          throw new OrderConflictError(
            'order.unpaid',
            `Order ${order.orderNumber} is ${order.status}: no confirmation is due`,
            { context: { status: order.status } },
          )
        }
        await publisher.publish(EVT_ORDER_CONFIRMATION_RESEND_REQUESTED, { orderId: order.id })
        return order
      })
    },
    async importOrder(input) {
      const capturedMinor = input.capturedMinor ?? 0
      const refundedMinor = input.refundedMinor ?? 0
      if (
        !(
          0 <= refundedMinor &&
          refundedMinor <= capturedMinor &&
          capturedMinor <= input.totalMinor
        ) ||
        capturedMinor > 0 !== (input.captureMethod != null)
      ) {
        throw new ValidationError('imported payment amounts are inconsistent', {
          context: { capturedMinor, refundedMinor, totalMinor: input.totalMinor },
        })
      }
      return store.transaction(async (tx) => {
        audit.note('order.import', [{ type: 'order', id: input.orderId }])
        const sequence = await repos.orderSequence.nextSequence(tx, deps.orderNumberStart)
        await repos.order.insert(tx, {
          id: input.orderId,
          orderNumber: input.orderNumber,
          sequence,
          customerId: input.customerId,
          status: input.status,
          email: input.email,
          billingAddress: input.billingAddress,
          shippingAddress: input.shippingAddress,
          lineItems: input.lineItems,
          subtotalMinor: input.subtotalMinor,
          taxTotalMinor: input.taxTotalMinor,
          shippingTotalMinor: input.shippingTotalMinor,
          discountTotalMinor: input.discountTotalMinor,
          totalMinor: input.totalMinor,
          currency: input.currency,
          notes: input.notes ?? '',
          metadata: input.metadata ?? {},
          paymentIntentId: input.paymentIntentId ?? null,
          ...(input.captureMethod != null && {
            capture: {
              amountMinor: capturedMinor,
              method: input.captureMethod,
              at: input.createdAt,
              refundedMinor,
            },
          }),
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        const fresh = await requireOrder(tx, input.orderId)
        await publisher.publish(EVT_ORDER_PLACED, { order: fresh })
        return fresh
      })
    },
  }
}
