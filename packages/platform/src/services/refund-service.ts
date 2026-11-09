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
  canRefund,
  paymentState,
  refundableMinor,
  type Logger,
  type Order,
  type OrderPayment,
  type OrderRefund,
  type OrderRefundStatus,
  type PaymentsAdapter,
  type ProviderRefund,
  type Refund,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { CommandStore, Tx } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { OrderRefundInsert } from '../repositories/order-refund.js'
import type { EventPublisher } from '../events/publisher.js'
import { formatMoney } from '../money.js'
import { REFUND_NOTE_PREFIX } from '../order-history-notes.js'

/** What the shop tells the provider; the merchant's own words stay on the refund row. */
export const PROVIDER_REFUND_REASON = 'requested_by_customer'

/** A row the provider has no record of is failed only after the store's own call to it can no longer be in flight. */
export const REFUND_UNKNOWN_AFTER_MS = 3_600_000

/** A pending row younger than this is most likely still in its own request; the sweep leaves it alone. */
export const RECONCILE_MIN_AGE_MS = 60_000

/** How a refund the provider reports with no row here is attributed on the row made for it. */
const PROVIDER_ACTOR = 'system:provider'

export type ReconcileResult =
  | { recorded: number; settled: number; failed: number }
  | { ignored: string }

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
  /**
   * Brings the order holding this intent up to the provider's list of its refunds. Only reads the provider: it can
   * settle or record a refund that happened, never make one.
   */
  reconcilePayment(paymentIntentId: string): Promise<ReconcileResult>
  /** `reconcilePayment` by the order's id; `no_payment` when the order has no intent to ask about. */
  reconcileOrder(orderId: string): Promise<ReconcileResult>
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

/**
 * Writes `refunded_minor` as Σ of the order's succeeded refunds, when that moves it: a refund that moved no money (failed
 * or still pending) leaves the order row as it was, so it needs no order event. The caller holds the order's lock.
 */
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
  const current = (await repos.order.findById(tx, orderId))!
  if (current.refundedMinor !== refundedMinor) {
    await repos.order.setRefunded(tx, orderId, refundedMinor, at)
  }
  return { refunds, refundedMinor }
}

/** What the effects of a refund need of its row, stored or just inserted. */
type RefundEffects = Pick<OrderRefund, 'id' | 'amountMinor' | 'currency' | 'reason' | 'actor'>

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
    if (!canRefund(order.status)) {
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
   * Step 3, under the order's lock again: the row is settled and `refunded_minor` recomputed from the rows. A refund
   * is money, so the order's status stays what it is; the history row and the events say what happened. A row another
   * writer settled first (the provider's webhook) keeps its effects; this request only answers the row as it stands.
   */
  async function settle(
    tx: Tx,
    orderId: string,
    row: OrderRefundInsert,
    settlement: Settlement,
  ): Promise<RefundResult> {
    const order = await repos.order.lock(tx, orderId)
    if (!order) throw new NotFoundError('order', orderId)
    const moved = await repos.orderRefund.settle(tx, row.id, {
      status: settlement.status,
      providerRefundId: settlement.providerRefundId,
    })
    if (moved) {
      const now = new Date()
      const { refunds, refundedMinor } = await refreshRefunded(repos, tx, order.id, now)
      const settled = refunds.find((r) => r.id === row.id)!
      if (settled.status === 'succeeded') {
        await recordSucceeded(tx, order, refundedMinor, settled, now)
      }
    }
    const refunds = await repos.orderRefund.listByOrder(tx, order.id)
    const refund = refunds.find((r) => r.id === row.id)!
    const fresh = (await repos.order.findById(tx, order.id))!
    return { order: fresh, payment: orderPayment(fresh, refunds), refund }
  }

  async function recordSucceeded(
    tx: Tx,
    order: Order,
    refundedMinor: number,
    refund: RefundEffects,
    now: Date,
  ): Promise<void> {
    const full = refundedMinor >= order.capturedMinor
    const note = `${REFUND_NOTE_PREFIX}${formatMoney(refund.amountMinor, refund.currency)}${refund.reason ? `: ${refund.reason}` : ''}`
    await repos.orderHistory.append(tx, {
      id: uuidv7(),
      orderId: order.id,
      fromStatus: order.status,
      toStatus: order.status,
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
    await publishPaymentRefunded(order, refund)
  }

  function publishPaymentRefunded(order: Order, refund: RefundEffects): Promise<unknown> {
    return publisher.publish(EVT_PAYMENT_REFUNDED, {
      paymentId: order.captureMethod === 'provider' ? (order.paymentIntentId ?? '') : '',
      orderId: order.id,
      refundId: refund.id,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
    })
  }

  /** The row ids whose provider-answer mismatch has been logged at error by this process. */
  const mismatchesLogged = new Set<string>()

  /** The pass's half under the order's lock: applies the provider's list to the order's rows. */
  async function applyList(
    tx: Tx,
    orderId: string,
    listing: ProviderRefund[],
  ): Promise<ReconcileResult> {
    const order = (await repos.order.lock(tx, orderId))!
    const rows = await repos.orderRefund.listByOrder(tx, orderId)
    const now = new Date()
    const result = { recorded: 0, settled: 0, failed: 0 }
    const noteChange = () => audit.note('order.reconcileRefunds', [{ type: 'order', id: orderId }])
    const matched = new Set<string>()
    let refundedMinor = rows
      .filter((r) => r.status === 'succeeded')
      .reduce((sum, r) => sum + r.amountMinor, 0)

    /** A cancelled order nets to zero: its refund is the payment's alone, as `refundCancelledCapture` records it. */
    const countSucceeded = async (refund: RefundEffects): Promise<void> => {
      refundedMinor = (await refreshRefunded(repos, tx, orderId, now)).refundedMinor
      if (order.status === 'cancelled') await publishPaymentRefunded(order, refund)
      else await recordSucceeded(tx, order, refundedMinor, refund, now)
    }

    for (const listed of listing) {
      const context = { orderId, refundId: listed.refundId }
      const row =
        rows.find((r) => r.providerRefundId === listed.refundId) ??
        rows.find((r) => r.id === listed.idempotencyKey)
      if (row === undefined) {
        if (listed.idempotencyKey !== null) {
          logger.warn(
            { ...context, key: listed.idempotencyKey },
            "this store's key on no row of the order",
          )
          continue
        }
        if (listed.status === 'failed') continue
        if (
          listed.currency.toUpperCase() !== order.currency.toUpperCase() ||
          refundedMinor + listed.amountMinor > order.capturedMinor
        ) {
          logger.error(
            { ...context, amountMinor: listed.amountMinor, currency: listed.currency },
            'provider refund refused: the order cannot hold it',
          )
          continue
        }
        const refund: OrderRefundInsert = {
          id: uuidv7(),
          orderId,
          providerRefundId: listed.refundId,
          status: listed.status,
          amountMinor: listed.amountMinor,
          currency: order.currency,
          reason: listed.reason,
          actor: PROVIDER_ACTOR,
          requestId: null,
          createdAt: now,
        }
        await repos.orderRefund.insert(tx, refund)
        noteChange()
        result.recorded += 1
        if (refund.status === 'succeeded') await countSucceeded(refund)
        continue
      }
      matched.add(row.id)
      if (row.status !== 'pending') {
        if (row.status !== listed.status && listed.status !== 'pending') {
          logger.error(
            { ...context, rowId: row.id, row: row.status, provider: listed.status },
            'a settled refund row disagrees with the provider',
          )
        }
        continue
      }
      const settlement = settlementOf(listed, row)
      if (settlement.mismatch) {
        const once = !mismatchesLogged.has(row.id)
        mismatchesLogged.add(row.id)
        logger[once ? 'error' : 'warn'](
          { ...context, rowId: row.id },
          'provider refund differs from the row; left pending',
        )
        continue
      }
      if (settlement.status === 'pending' && row.providerRefundId === listed.refundId) continue
      await repos.orderRefund.settle(tx, row.id, {
        status: settlement.status,
        providerRefundId: settlement.providerRefundId,
      })
      noteChange()
      row.status = settlement.status
      row.providerRefundId = settlement.providerRefundId
      if (settlement.status === 'failed') result.failed += 1
      if (settlement.status === 'succeeded') {
        result.settled += 1
        await countSucceeded(row)
      }
    }

    const unknownBefore = now.getTime() - REFUND_UNKNOWN_AFTER_MS
    for (const row of rows) {
      if (
        row.status !== 'pending' ||
        row.providerRefundId !== null ||
        matched.has(row.id) ||
        new Date(row.createdAt).getTime() >= unknownBefore
      ) {
        continue
      }
      await repos.orderRefund.settle(tx, row.id, { status: 'failed', providerRefundId: null })
      noteChange()
      result.failed += 1
    }
    return result
  }

  /** The guards, then the list read outside any transaction: no provider call holds SQLite's write lock. */
  async function reconcile(order: Order, paymentIntentId: string): Promise<ReconcileResult> {
    if (order.captureMethod === 'manual' || order.captureMethod === 'import') {
      return { ignored: 'not_provider_captured' }
    }
    if (order.capturedMinor === 0) {
      if (order.status === 'pending') {
        throw new PaymentError(
          'capture_not_recorded',
          `Order ${order.orderNumber} has a refund before its capture`,
          { context: { orderId: order.id } },
        )
      }
      logger.error(
        { orderId: order.id, status: order.status },
        'a provider refund for an order with no recorded capture; ignored',
      )
      return { ignored: 'capture_never_recorded' }
    }
    let listing: ProviderRefund[]
    try {
      listing = await payments.listRefunds(paymentIntentId)
    } catch (err) {
      throw new PaymentError(
        'refund_lookup_failed',
        `Could not list the refunds of payment ${paymentIntentId}`,
        { cause: err, context: { orderId: order.id } },
      )
    }
    return store.transaction((tx) => applyList(tx, order.id, listing))
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

    async reconcilePayment(paymentIntentId) {
      const order = await store.read((tx) => repos.order.findByPaymentIntentId(tx, paymentIntentId))
      return order === null ? { ignored: 'unknown_order' } : reconcile(order, paymentIntentId)
    },

    async reconcileOrder(orderId) {
      const order = await store.read((tx) => repos.order.findById(tx, orderId))
      return order?.paymentIntentId
        ? reconcile(order, order.paymentIntentId)
        : { ignored: 'no_payment' }
    },
  }
}
