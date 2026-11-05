import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { EVT_ORDER_SHIPPED } from '@nymbalhq/types'
import { address, type Kernel } from './kernel.js'
import type { AdminClient } from './money.js'
import { eventRows, type EventRow } from './outbox.js'
import type { RawReader } from './raw.js'

// Orders for the shipping registration tests: one in `processing`, ready for the admin's ship action; the relay
// drained until every event is delivered or dead; and what an order's order.shipped.v1 left behind.

/** The idempotency name the registration handler marks an order.shipped.v1 with once it has handled it. */
export const START_TRACKING_HANDLER = 'shipping:order-shipped'

/** An imported order in `processing`, paid, which the admin's ship action can move to `shipped`. */
export async function processingOrder(k: Kernel): Promise<{ id: string; email: string }> {
  const id = randomUUID()
  const email = `buyer-${randomUUID()}@shipping.test`
  await k.services.order.importOrder({
    orderId: id,
    orderNumber: `SHIP-${randomUUID().slice(0, 8)}`,
    status: 'processing',
    customerId: null,
    email,
    billingAddress: address,
    shippingAddress: address,
    lineItems: [
      {
        variantId: randomUUID(),
        productId: randomUUID(),
        productName: 'Parcel Widget',
        variantName: 'Default',
        sku: 'PARCEL-1',
        qty: 1,
        unitPriceMinor: 1200,
        lineSubtotalMinor: 1200,
        lineTaxMinor: 0,
        lineTotalMinor: 1200,
        imageUrl: '',
      },
    ],
    subtotalMinor: 1200,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 1200,
    currency: 'GBP',
    createdAt: new Date(),
    capturedMinor: 1200,
    captureMethod: 'import',
  })
  return { id, email }
}

/** The admin's Mark Shipped: [HTTP status, the order's status as the route answered it]. */
export async function shipThroughAdmin(
  admin: AdminClient,
  orderId: string,
  trackingNumber: string,
  carrier: string,
): Promise<[number, unknown]> {
  const res = await admin.call<{ status?: unknown }>('POST', `/api/admin/orders/${orderId}/ship`, {
    trackingNumber,
    carrier,
  })
  return [res.status, res.body.data?.status ?? res.body.error?.code]
}

/** Drains the relay until every event is delivered or dead, so every handler run that will happen has. */
export async function drained(k: Kernel, raw: RawReader): Promise<void> {
  await vi.waitFor(
    async () => {
      await k.app.relay.drain()
      const open = (await eventRows(raw)).filter((r) => r.deliveredAt == null && r.deadAt == null)
      expect(open.map((r) => r.type)).toEqual([])
    },
    { timeout: 15_000, interval: 20 },
  )
}

/** The order's order.shipped.v1 rows. */
export async function shippedEvents(raw: RawReader, orderId: string): Promise<EventRow[]> {
  return (await eventRows(raw, 'type = ?', [EVT_ORDER_SHIPPED])).filter(
    (r) => (r.envelope.payload as { orderId?: unknown }).orderId === orderId,
  )
}

/** How many processed marks `handler` holds for the event. */
export function processedBy(raw: RawReader, handler: string, eventId: string): Promise<number> {
  return raw.count('processed_events', 'handler_name = ? AND event_id = ?', [handler, eventId])
}

/** [status, every history row as [from, to, actor]] for the order. */
export async function orderState(raw: RawReader, orderId: string): Promise<[string, string[][]]> {
  const { status } = await raw.one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [
    orderId,
  ])
  const history = await raw.rows<{ from_status: string | null; to_status: string; actor: string }>(
    'SELECT from_status, to_status, actor FROM order_history WHERE order_id = ? ORDER BY rowid',
    [orderId],
  )
  return [status, history.map((h) => [String(h.from_status), h.to_status, h.actor])]
}
