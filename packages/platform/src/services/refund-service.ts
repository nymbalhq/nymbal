import { v7 as uuidv7 } from 'uuid'
import {
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_ORDER_REFUNDED,
  EVT_PAYMENT_REFUNDED,
  NotFoundError,
  OrderConflictError,
  PaymentError,
  StatusTransitionError,
  ValidationError,
  canTransitionOrder,
  paymentState,
  refundableMinor,
  type Logger,
  type Order,
  type OrderPayment,
  type OrderRefund,
  type OrderRefundStatus,
  type PaymentsAdapter,
  type Refund,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { CommandStore, Tx } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { OrderRefundInsert } from '../repositories/order-refund.js'
import type { EventPublisher } from '../events/publisher.js'
import { formatMoney } from '../money.js'

/** What the shop tells the provider; the merchant's own words stay on the refund row. */
export const PROVIDER_REFUND_REASON = 'requested_by_customer'

export interface RefundInput {
  orderId: string
  amountMinor: number
  reason?: string
  actor: string
  /** The client's key for this request: a repeat on the order answers the refund the first one made. */
  requestId?: string
}

export interface RefundResult {
  order: Order
  payment: OrderPayment
  refund: OrderRefund
}

export interface RefundService {
  /**
   * Refunds part or all of what the order captured, through the payments provider when the provider took the money.
   * The refund is held as a `pending` row under the order's lock, the provider is called outside any transaction with
   * the row id as its idempotency key, and the row is settled under the lock again by the provider's answer. A
   * `requestId` the order has already seen answers that refund as it stands and moves no money;
   * `refund.request_reused` when the amount differs.
   */
  refund(input: RefundInput): Promise<RefundResult>
}

export interface CreateRefundServiceDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
  payments: PaymentsAdapter
}

export function orderPayment(order: Order, refunds: OrderRefund[]): OrderPayment {
  return {
    state: paymentState(order),
    capturedMinor: order.capturedMinor,
    refundedMinor: order.refundedMinor,
    refundableMinor: refundableMinor(order, refunds),
    currency: order.currency,
    refunds,
  }
}

export interface Settlement {
  status: OrderRefundStatus
  providerRefundId: string | null
  /** The provider answered for another amount or currency than the row's. */
  mismatch: boolean
}

/** The provider's answer settles a refund row as succeeded only when it is for the row's amount and currency. */
export function settlementOf(
  answer: Refund,
  row: Pick<OrderRefund, 'amountMinor' | 'currency'>,
): Settlement {
  const matches =
    answer.amountMinor === row.amountMinor &&
    answer.currency.toUpperCase() === row.currency.toUpperCase()
  const providerRefundId = answer.refundId
  if (answer.status === 'failed') return { status: 'failed', providerRefundId, mismatch: false }
  if (!matches) return { status: 'pending', providerRefundId, mismatch: true }
  return { status: answer.status, providerRefundId, mismatch: false }
}

/** Writes `refunded_minor` as Σ of the order's succeeded refunds. */
export async function refreshRefunded(
  repos: Repositories,
  tx: Tx,
  orderId: string,
  at: Date,
): Promise<{ refunds: OrderRefund[]; refundedMinor: number }> {
  const refunds = await repos.orderRefund.listByOrder(tx, orderId)
  const refundedMinor = refunds
    .filter((r) => r.status === 'succeeded')
    .reduce((sum, r) => sum + r.amountMinor, 0)
  await repos.order.setRefunded(tx, orderId, refundedMinor, at)
  return { refunds, refundedMinor }
}

export function createRefundService(deps: CreateRefundServiceDeps): RefundService {
  const { store, repos, publisher, logger, payments } = deps

  /**
   * Step 1, under the order's lock: a repeated request answers its refund; otherwise the refund is checked against
   * what is refundable and held as a pending row.
   */
  async function hold(
    tx: Tx,
    input: RefundInput,
  ): Promise<{ order: Order; row: OrderRefundInsert } | { repeat: RefundResult }> {
    audit.note('order.refund', [{ type: 'order', id: input.orderId }])
    const order = await repos.order.lock(tx, input.orderId)
    if (!order) throw new NotFoundError('order', input.orderId)
    if (input.requestId !== undefined) {
      const earlier = await repos.orderRefund.findByRequestId(tx, order.id, input.requestId)
      if (earlier !== null) {
        if (earlier.amountMinor !== input.amountMinor) {
          throw new OrderConflictError(
            'refund.request_reused',
            `Request ${input.requestId} already refunded ${formatMoney(earlier.amountMinor, earlier.currency)} on order ${order.orderNumber}`,
            {
              context: { amountMinor: input.amountMinor, earlierAmountMinor: earlier.amountMinor },
            },
          )
        }
        const refunds = await repos.orderRefund.listByOrder(tx, order.id)
        return { repeat: { order, payment: orderPayment(order, refunds), refund: earlier } }
      }
    }
    if (
      order.capturedMinor <= 0 ||
      (order.captureMethod === 'provider' && !order.paymentIntentId)
    ) {
      throw new OrderConflictError(
        'refund.not_captured',
        `Order ${order.orderNumber} has no captured payment to refund`,
      )
    }
    const refundable = refundableMinor(order, await repos.orderRefund.listByOrder(tx, order.id))
    if (input.amountMinor > refundable) {
      throw new OrderConflictError(
        'refund.exceeds_captured',
        `Refund of ${formatMoney(input.amountMinor, order.currency)} exceeds the ${formatMoney(refundable, order.currency)} refundable on order ${order.orderNumber}`,
        { context: { amountMinor: input.amountMinor, refundableMinor: refundable } },
      )
    }
    if (!canTransitionOrder(order.status, 'refunded')) {
      throw new StatusTransitionError('order', order.status, 'refunded')
    }
    const row: OrderRefundInsert = {
      id: uuidv7(),
      orderId: order.id,
      amountMinor: input.amountMinor,
      currency: order.currency,
      providerRefundId: null,
      status: 'pending',
      reason: input.reason ?? null,
      actor: input.actor,
      createdAt: new Date(),
      requestId: input.requestId ?? null,
    }
    await repos.orderRefund.insert(tx, row)
    return { order, row }
  }

  /**
   * Step 2, outside any transaction. A manual or imported capture moves no money through the provider. A definite
   * refusal fails the row; an unknown outcome leaves it pending, held against the capture until it is reconciled.
   */
  async function moveMoney(order: Order, row: OrderRefundInsert): Promise<Settlement> {
    if (order.captureMethod !== 'provider') {
      return { status: 'succeeded', providerRefundId: null, mismatch: false }
    }
    const context = { orderId: order.id, refundId: row.id, amountMinor: row.amountMinor }
    try {
      const answer = await payments.refund(
        order.paymentIntentId!,
        row.amountMinor,
        PROVIDER_REFUND_REASON,
        { idempotencyKey: row.id, currency: order.currency },
      )
      const settlement = settlementOf(answer, row)
      if (settlement.mismatch) {
        logger.error(
          { ...context, answer: { amountMinor: answer.amountMinor, currency: answer.currency } },
          'provider refund answer differs from the refund; left pending',
        )
      }
      return settlement
    } catch (err) {
      if (err instanceof PaymentError && err.code === 'payment.refund_rejected') {
        logger.warn({ ...context, err }, 'provider refused the refund')
        return { status: 'failed', providerRefundId: null, mismatch: false }
      }
      logger.error({ ...context, err }, 'refund outcome unknown; left pending until reconciled')
      return { status: 'pending', providerRefundId: null, mismatch: false }
    }
  }

  /**
   * Step 3, under the order's lock again: the row is settled, `refunded_minor` recomputed from the rows, and the status
   * moved. The money has moved by now, so a status that no longer allows the move is kept and logged, never an error.
   */
  async function settle(
    tx: Tx,
    orderId: string,
    row: OrderRefundInsert,
    settlement: Settlement,
  ): Promise<RefundResult> {
    const order = await repos.order.lock(tx, orderId)
    if (!order) throw new NotFoundError('order', orderId)
    await repos.orderRefund.settle(tx, row.id, {
      status: settlement.status,
      providerRefundId: settlement.providerRefundId,
    })
    const now = new Date()
    const { refunds, refundedMinor } = await refreshRefunded(repos, tx, order.id, now)
    const refund = refunds.find((r) => r.id === row.id)!
    if (refund.status === 'succeeded') await recordSucceeded(tx, order, refundedMinor, refund, now)
    const fresh = (await repos.order.findById(tx, order.id))!
    return { order: fresh, payment: orderPayment(fresh, refunds), refund }
  }

  async function recordSucceeded(
    tx: Tx,
    order: Order,
    refundedMinor: number,
    refund: OrderRefund,
    now: Date,
  ): Promise<void> {
    const full = refundedMinor >= order.capturedMinor
    const target = full ? 'refunded' : 'partially_refunded'
    const note = `refund of ${formatMoney(refund.amountMinor, refund.currency)}${refund.reason ? `: ${refund.reason}` : ''}`
    let toStatus = order.status
    if (order.status !== target && canTransitionOrder(order.status, target)) {
      await repos.order.setStatus(tx, order.id, target, now)
      toStatus = target
    } else if (order.status !== target) {
      logger.warn(
        { orderId: order.id, refundId: refund.id, status: order.status, wanted: target },
        'refund settled; the order status no longer allows the move and is kept',
      )
    }
    await repos.orderHistory.append(tx, {
      id: uuidv7(),
      orderId: order.id,
      fromStatus: order.status,
      toStatus,
      actor: refund.actor,
      note,
      timestamp: now,
    })
    if (order.customerId) {
      await repos.customer.incrementStats(tx, order.customerId, 0, -refund.amountMinor, now)
    }
    const payload = {
      orderId: order.id,
      refundId: refund.id,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      reason: refund.reason ?? '',
    }
    await publisher.publish(full ? EVT_ORDER_REFUNDED : EVT_ORDER_PARTIALLY_REFUNDED, payload)
    await publisher.publish(EVT_PAYMENT_REFUNDED, {
      paymentId: order.captureMethod === 'provider' ? (order.paymentIntentId ?? '') : '',
      orderId: order.id,
      refundId: refund.id,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
    })
  }

  return {
    async refund(input) {
      audit.note('order.refund', [{ type: 'order', id: input.orderId }])
      if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
        throw new ValidationError('amountMinor must be a positive whole number of minor units', {
          context: { amountMinor: input.amountMinor },
        })
      }
      const held = await store.transaction((tx) => hold(tx, input))
      if ('repeat' in held) return held.repeat
      const { order, row } = held
      const settlement = await moveMoney(order, row)
      return store.transaction((tx) => settle(tx, order.id, row, settlement))
    },
  }
}
