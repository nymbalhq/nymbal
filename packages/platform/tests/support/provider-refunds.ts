import { randomUUID } from 'node:crypto'
import type { OrderStatus, PaymentsAdapter, ProviderRefund, Refund } from '@nymbalhq/types'
import type { ReconcileResult } from '../../src/services/refund-service.js'
import { REFUND_NOTE_PREFIX } from '../../src/order-history-notes.js'
import { address, cartWith, seedVariant, type Kernel } from './kernel.js'
import type { RawReader } from './raw.js'
import { eventsOfType, type WebhookAnswer, deliver } from './webhooks.js'
import { unaudited } from './write-audit.js'

// The provider's side of a refund as the kernel's route meets it: the stub's `payment.refunded` body and the list a
// test makes the adapter answer.

/** A refund as the provider's list reports it: `Refund` plus the idempotency key it was made under. */
export type ListedRefund = ProviderRefund

export type ReconcileAnswer = ReconcileResult

export function reconcileOrder(k: Kernel, orderId: string): Promise<ReconcileAnswer> {
  return k.services.refund.reconcileOrder(orderId)
}

export function reconcilePayment(k: Kernel, paymentIntentId: string): Promise<ReconcileAnswer> {
  return k.services.refund.reconcilePayment(paymentIntentId)
}

/** The adapter's own list. */
export function providerList(adapter: PaymentsAdapter, paymentId: string): Promise<ListedRefund[]> {
  return adapter.listRefunds(paymentId)
}

export interface ListingControl {
  /** How many times the store asked for a list. */
  calls(): number
  restore(): void
}

/** Makes the adapter answer `list` for the next lookups, counting each call. */
export function answerListWith(
  adapter: PaymentsAdapter,
  list: (paymentId: string) => ListedRefund[] | Promise<ListedRefund[]>,
): ListingControl {
  const original = adapter.listRefunds
  let calls = 0
  adapter.listRefunds = async (paymentId) => {
    calls += 1
    return list(paymentId)
  }
  return {
    calls: () => calls,
    restore() {
      adapter.listRefunds = original
    },
  }
}

export function listed(
  paymentId: string,
  overrides: Partial<ListedRefund> & Pick<ListedRefund, 'refundId' | 'amountMinor'>,
): ListedRefund {
  return {
    paymentId,
    currency: 'GBP',
    reason: null,
    status: 'succeeded',
    idempotencyKey: null,
    ...overrides,
  }
}

export interface RefundedBody {
  eventId?: string
  refund?: { id: string; amountMinor: number; status?: Refund['status'] }
}

/** A `payment.refunded` delivery for the stub adapter: its route request, the same bytes for a repeat of `eventId`. */
export function refundedDelivery(paymentIntentId: string | undefined, body: RefundedBody = {}) {
  return {
    method: 'POST' as const,
    path: '/api/webhooks/stripe' as const,
    headers: { 'content-type': 'application/json', 'stripe-signature': 'proof-kit-stub' },
    body: JSON.stringify({
      id: body.eventId ?? `evt_${randomUUID()}`,
      kind: 'payment.refunded',
      ...(paymentIntentId !== undefined && { paymentIntentId }),
      ...(body.refund !== undefined && { refund: body.refund }),
    }),
  }
}

export function deliverRefunded(
  baseUrl: string,
  paymentIntentId: string | undefined,
  body: RefundedBody = {},
): Promise<WebhookAnswer> {
  return deliver(baseUrl, refundedDelivery(paymentIntentId, body))
}

export interface PaidOrder {
  orderId: string
  orderNumber: string
  intentId: string
  totalMinor: number
  currency: string
  status: string
}

/** A checkout the stub captures inline: confirmed, its total captured, owned by `customerId` when given. */
export async function paidOrder(
  k: Kernel,
  opts: { priceMinor?: number; customerId?: string } = {},
): Promise<PaidOrder> {
  const seeded = await seedVariant(k, 3, { priceMinor: opts.priceMinor ?? 10_000 })
  const started = await k.services.checkout.beginCheckout({
    cartToken: await cartWith(k, seeded, 1),
    email: `refunds-${randomUUID()}@money.test`,
    billingAddress: address,
    shippingAddress: address,
    ...(opts.customerId !== undefined && { customerId: opts.customerId }),
  })
  return {
    orderId: started.orderId,
    orderNumber: started.orderNumber,
    intentId: started.paymentIntent.id,
    totalMinor: started.totalMinor,
    currency: started.currency,
    status: started.orderStatus as OrderStatus,
  }
}

export interface RefundRow {
  id: string
  orderId: string
  amountMinor: number
  status: 'pending' | 'succeeded' | 'failed'
  providerRefundId?: string | null
  actor?: string
  createdAt?: Date
}

/** A refund row as a test states it, with the order's `refunded_minor` kept to Σ succeeded so the row is one a store holds. */
export async function insertRefund(k: Kernel, row: RefundRow): Promise<void> {
  const now = row.createdAt ?? new Date()
  await unaudited(() =>
    k.store.transaction(async (tx) => {
      await k.repos.orderRefund.insert(tx, {
        id: row.id,
        orderId: row.orderId,
        amountMinor: row.amountMinor,
        currency: 'GBP',
        providerRefundId: row.providerRefundId ?? null,
        status: row.status,
        reason: null,
        actor: row.actor ?? 'admin:refunds',
        createdAt: now,
      })
      if (row.status === 'succeeded') {
        const rows = await k.repos.orderRefund.listByOrder(tx, row.orderId)
        const refunded = rows
          .filter((r) => r.status === 'succeeded')
          .reduce((sum, r) => sum + r.amountMinor, 0)
        await k.repos.order.setRefunded(tx, row.orderId, refunded, now)
      }
    }),
  )
}

export interface RefundHistory {
  fromStatus: string | null
  toStatus: string
  actor: string
  note: string
}

/** The order's history rows that record a refund, oldest first. */
export async function refundHistory(raw: RawReader, orderId: string): Promise<RefundHistory[]> {
  const rows = await raw.rows<{
    from_status: string | null
    to_status: string
    actor: string
    note: string
  }>(
    'SELECT from_status, to_status, actor, note FROM order_history WHERE order_id = ? ORDER BY timestamp, id',
    [orderId],
  )
  return rows
    .filter((r) => r.note.startsWith(REFUND_NOTE_PREFIX))
    .map((r) => ({
      fromStatus: r.from_status,
      toStatus: r.to_status,
      actor: r.actor,
      note: r.note,
    }))
}

interface RefundEvent {
  orderId: string
  refundId: string
  amountMinor: number
}

/** The `type` events naming this order, in sequence order. */
export async function refundEvents(
  raw: RawReader,
  type: 'payment.refunded.v1' | 'order.refunded.v1' | 'order.partially_refunded.v1',
  orderId: string,
): Promise<RefundEvent[]> {
  return (await eventsOfType<RefundEvent>(raw, type)).filter((e) => e.orderId === orderId)
}

/** Every refund event the order has, whatever its type: the set a double count would add to. */
export async function allRefundEvents(raw: RawReader, orderId: string): Promise<RefundEvent[]> {
  return [
    ...(await refundEvents(raw, 'payment.refunded.v1', orderId)),
    ...(await refundEvents(raw, 'order.refunded.v1', orderId)),
    ...(await refundEvents(raw, 'order.partially_refunded.v1', orderId)),
  ]
}

/** What the customer has spent, as the command store holds it. */
export async function customerSpend(raw: RawReader, customerId: string): Promise<number> {
  const row = await raw.one<{ total_spent_minor: number | string }>(
    'SELECT total_spent_minor FROM customers WHERE id = ?',
    [customerId],
  )
  return Number(row.total_spent_minor)
}

/** A registered customer of its own, for an order whose stats a test reads. */
export async function registeredCustomer(k: Kernel): Promise<string> {
  const { customer } = await k.services.auth.register({
    email: `refund-buyer-${randomUUID()}@money.test`,
    password: 'correct-horse-battery',
  })
  return customer.id
}
