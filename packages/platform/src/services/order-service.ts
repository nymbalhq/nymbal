import { v7 as uuidv7 } from 'uuid'
import {
  EVT_ORDER_CANCELLED,
  EVT_ORDER_DELIVERED,
  EVT_ORDER_PAID,
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_ORDER_PLACED,
  EVT_ORDER_REFUNDED,
  EVT_ORDER_SHIPPED,
  NotFoundError,
  assertOrderTransition,
  type Address,
  type Logger,
  type Order,
  type OrderLineItem,
  type OrderStatus,
} from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'

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
}

export interface OrderImportInput extends OrderCreateDraftInput {
  orderNumber: string
  status: OrderStatus
  createdAt: Date
}

export interface OrderService {
  createFromCheckout(input: OrderCreateDraftInput): Promise<Order>
  importOrder(input: OrderImportInput): Promise<Order>
  getById(id: string): Promise<Order>
  getByOrderNumber(orderNumber: string): Promise<Order>
  listByCustomer(customerId: string): Promise<Order[]>
  updateStatus(id: string, toStatus: OrderStatus, actor: string, note?: string): Promise<Order>
  markShipped(id: string, trackingNumber: string, carrier: string, actor: string): Promise<Order>
  markDelivered(id: string, actor: string): Promise<Order>
  cancel(id: string, reason: string, actor: string): Promise<Order>
  refund(id: string, amountMinor: number, reason: string, actor: string): Promise<Order>
  partialRefund(
    id: string,
    amountMinor: number,
    lineItems: OrderLineItem[],
    reason: string,
    actor: string,
  ): Promise<Order>
  markPaid(id: string, paymentIntentId: string, amountMinor: number, currency: string): Promise<Order>
}

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

  async function requireOrder(id: string): Promise<Order> {
    const order = await repos.order.findById(id)
    if (!order) throw new NotFoundError('order', id)
    return order
  }

  async function doTransition(
    order: Order,
    toStatus: OrderStatus,
    actor: string,
    note: string,
  ): Promise<Order> {
    assertOrderTransition(order.status, toStatus)
    const now = new Date()
    await store.transaction(async () => {
      await repos.order.setStatus(order.id, toStatus, now)
      await repos.orderHistory.append({
        id: uuidv7(),
        orderId: order.id,
        fromStatus: order.status,
        toStatus,
        actor,
        note,
        timestamp: now,
      })
    })
    return requireOrder(order.id)
  }

  return {
    async createFromCheckout(input) {
      return store.transaction(async () => {
        const sequence = await repos.orderSequence.nextSequence(deps.orderNumberStart)
        const orderNumber = `${deps.orderNumberPrefix}-${sequence + 1}`
        const now = new Date()
        await repos.order.insert({
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
          createdAt: now,
          updatedAt: now,
        })
        await repos.orderHistory.append({
          id: uuidv7(),
          orderId: input.orderId,
          fromStatus: null,
          toStatus: 'pending',
          actor: 'system:checkout',
          note: 'order draft created',
          timestamp: now,
        })
        const fresh = await requireOrder(input.orderId)
        await publisher.publish(EVT_ORDER_PLACED, { order: fresh })
        return fresh
      })
    },

    async getById(id) {
      return requireOrder(id)
    },
    async getByOrderNumber(orderNumber) {
      const order = await repos.order.findByOrderNumber(orderNumber)
      if (!order) throw new NotFoundError('order', orderNumber)
      return order
    },
    async listByCustomer(customerId) {
      return repos.order.listByCustomer(customerId)
    },
    async updateStatus(id, toStatus, actor, note = '') {
      const order = await requireOrder(id)
      return doTransition(order, toStatus, actor, note)
    },
    async markShipped(id, trackingNumber, carrier, actor) {
      const order = await requireOrder(id)
      const fresh = await doTransition(order, 'shipped', actor, `Shipped via ${carrier}: ${trackingNumber}`)
      await publisher.publish(EVT_ORDER_SHIPPED, {
        orderId: fresh.id,
        trackingNumber,
        carrier,
      })
      return fresh
    },
    async markDelivered(id, actor) {
      const order = await requireOrder(id)
      const fresh = await doTransition(order, 'delivered', actor, 'Delivered')
      await publisher.publish(EVT_ORDER_DELIVERED, { orderId: fresh.id })
      return fresh
    },
    async cancel(id, reason, actor) {
      const order = await requireOrder(id)
      const fresh = await doTransition(order, 'cancelled', actor, reason)
      await publisher.publish(EVT_ORDER_CANCELLED, { orderId: fresh.id, reason })
      return fresh
    },
    async refund(id, amountMinor, reason, actor) {
      const order = await requireOrder(id)
      const fresh = await doTransition(order, 'refunded', actor, reason)
      await publisher.publish(EVT_ORDER_REFUNDED, {
        orderId: fresh.id,
        amountMinor,
        reason,
      })
      return fresh
    },
    async partialRefund(id, amountMinor, lineItems, reason, actor) {
      const order = await requireOrder(id)
      const fresh = await doTransition(order, 'partially_refunded', actor, reason)
      await publisher.publish(EVT_ORDER_PARTIALLY_REFUNDED, {
        orderId: fresh.id,
        amountMinor,
        lineItems,
        reason,
      })
      return fresh
    },
    async markPaid(id, paymentIntentId, amountMinor, currency) {
      const order = await requireOrder(id)
      await repos.order.setPaymentIntent(order.id, paymentIntentId, new Date())
      // status transition pending → confirmed happens in CheckoutService.finalize;
      // here we just emit the event.
      await publisher.publish(EVT_ORDER_PAID, {
        orderId: order.id,
        paymentIntentId,
        amountMinor,
        currency,
      })
      return requireOrder(order.id)
    },

    async importOrder(input) {
      return store.transaction(async () => {
        const sequence = await repos.orderSequence.nextSequence(deps.orderNumberStart)
        await repos.order.insert({
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
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        const fresh = await requireOrder(input.orderId)
        await publisher.publish(EVT_ORDER_PLACED, { order: fresh })
        return fresh
      })
    },
  }
}
