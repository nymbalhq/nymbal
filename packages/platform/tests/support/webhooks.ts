import { randomUUID } from 'node:crypto'
import type { OrderPaidV1Payload, PaymentFailedV1Payload } from '@nymbalhq/types'
import { createCheckoutService } from '../../src/services/checkout-service.js'
import { startInventoryReservationSweeper } from '../../src/sweepers/inventory-reservation-sweeper.js'
import { address, cartWith, type Kernel, type Seeded } from './kernel.js'
import type { RawReader } from './raw.js'
import { stubPaymentWebhook, type StubPaymentWebhookRequest } from './proof-kit.js'

// P1-05 support: the captured-payment webhook as the kernel's route sees it, and the committed records a delivery
// leaves behind, read through a second connection. Events are read from the `events` table (the outbox from P1-03),
// so a test never waits on the bus.

/** The handler name decision 3 gives the Stripe route's processed-event record. */
export const WEBHOOK_HANDLER = 'webhook:stripe'

/** What beginCheckout returned, as far as a webhook needs it. */
export interface Started {
  orderId: string
  paymentIntent: { id: string }
  totalMinor: number
  currency: string
}

export interface WebhookAnswer {
  status: number
  data?: Record<string, unknown>
  error?: { code: string; message: string }
}

export async function deliver(
  baseUrl: string,
  request: Pick<StubPaymentWebhookRequest, 'method' | 'path' | 'headers' | 'body'>,
): Promise<WebhookAnswer> {
  const res = await fetch(new URL(request.path, baseUrl), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  })
  const text = await res.text()
  const body = text === '' ? {} : (JSON.parse(text) as Omit<WebhookAnswer, 'status'>)
  return { status: res.status, ...body }
}

/** A `payment.captured` for the order's real total and currency unless an override says otherwise. */
export function captureFor(
  started: Started,
  overrides: Partial<{ amountMinor: number; currency: string; eventId: string }> = {},
): StubPaymentWebhookRequest {
  return stubPaymentWebhook({
    paymentIntentId: started.paymentIntent.id,
    amountMinor: overrides.amountMinor ?? started.totalMinor,
    currency: overrides.currency ?? started.currency,
    eventId: overrides.eventId ?? `evt_${randomUUID()}`,
  })
}

export function deliverCapture(
  baseUrl: string,
  started: Started,
  overrides: Partial<{ amountMinor: number; currency: string; eventId: string }> = {},
): Promise<WebhookAnswer> {
  return deliver(baseUrl, captureFor(started, overrides))
}

/** Payloads of every committed event of `type`, in sequence order. */
export async function eventsOfType<T>(raw: RawReader, type: string): Promise<T[]> {
  const rows = await raw.rows<{ envelope: string | { payload: T } }>(
    'SELECT envelope FROM events WHERE type = ? ORDER BY seq',
    [type],
  )
  return rows.map((row) =>
    typeof row.envelope === 'string'
      ? (JSON.parse(row.envelope) as { payload: T }).payload
      : row.envelope.payload,
  )
}

export async function paidFor(raw: RawReader, orderId: string): Promise<OrderPaidV1Payload[]> {
  const all = await eventsOfType<OrderPaidV1Payload>(raw, 'order.paid.v1')
  return all.filter((p) => p.orderId === orderId)
}

export async function failedFor(
  raw: RawReader,
  match: { orderId?: string; paymentId?: string },
): Promise<PaymentFailedV1Payload[]> {
  const all = await eventsOfType<PaymentFailedV1Payload>(raw, 'payment.failed.v1')
  return all.filter(
    (p) =>
      (match.orderId === undefined || p.orderId === match.orderId) &&
      (match.paymentId === undefined || p.paymentId === match.paymentId),
  )
}

/** How many processed-event records the Stripe route holds for `eventId`: 0 or 1. */
export function processedCount(raw: RawReader, eventId: string): Promise<number> {
  return raw.count('processed_events', 'handler_name = ? AND event_id = ?', [
    WEBHOOK_HANDLER,
    eventId,
  ])
}

export async function orderStatus(raw: RawReader, orderId: string): Promise<string> {
  const row = await raw.one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [orderId])
  return row.status
}

export async function historyNotes(raw: RawReader, orderId: string): Promise<string[]> {
  const rows = await raw.rows<{ note: string }>(
    'SELECT note FROM order_history WHERE order_id = ? ORDER BY timestamp',
    [orderId],
  )
  return rows.map((r) => r.note)
}

export function reservationsFor(raw: RawReader, orderId: string): Promise<number> {
  return raw.count('inventory_reservations', 'order_ref = ?', [orderId])
}

export function adjustmentsFor(raw: RawReader, variantId: string): Promise<number> {
  return raw.count('stock_adjustments', 'variant_id = ?', [variantId])
}

/**
 * A late payment's starting state: a checkout whose reservations were taken with a TTL already in the past, then one
 * sweeper tick, so the reservation rows are gone and the stock is back. The order is still pending with its
 * reservation ids in its metadata, exactly as a 3DS or delayed-method payment finds it after the 15-minute TTL.
 */
export async function expiredCheckout(
  k: Kernel,
  seeded: Seeded,
  qty: number,
  opts: { customerId?: string; email?: string } = {},
) {
  const inventory: Kernel['services']['inventory'] = {
    ...k.services.inventory,
    reserveStock(variantId, reserveQty, orderRef) {
      return k.services.inventory.reserveStock(variantId, reserveQty, orderRef, -3600)
    },
  }
  const checkout = createCheckoutService({
    store: k.store,
    repos: k.repos,
    publisher: k.publisher,
    logger: k.logger,
    cart: k.services.cart,
    orders: k.services.order,
    inventory,
    payments: k.app.adapters.payments,
    currency: k.config.store.currency,
  })
  const cartToken = await cartWith(k, seeded, qty)
  const started = await checkout.beginCheckout({
    cartToken,
    email: opts.email ?? `late-${randomUUID()}@p1-05.test`,
    billingAddress: address,
    shippingAddress: address,
    ...(opts.customerId !== undefined && { customerId: opts.customerId }),
  })
  const sweeper = startInventoryReservationSweeper({
    inventoryService: k.services.inventory,
    reservationRepo: k.repos.inventoryReservation,
    logger: k.logger,
    intervalMs: 3_600_000,
  })
  try {
    await sweeper.tick()
  } finally {
    sweeper.stop()
  }
  return { ...started, cartToken }
}
