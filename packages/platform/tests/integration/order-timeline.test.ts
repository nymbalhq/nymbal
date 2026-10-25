import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PaymentsAdapter, Refund } from '@nymbalhq/types'
import { rebuild } from '../../src/read-models/index.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { adminClient, adminOrder, type AdminClient } from '../support/money.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { rebuildDeps } from '../support/read-models.js'
import { deliverCapture } from '../support/webhooks.js'

// AC-2 on SQLite, a kernel from `src/` served over HTTP. An order placed by checkout (paid inline by the stub, or left
// pending by `+stub-pending`) is driven by random legal sequences of the admin's commands (process, ship, deliver,
// mark-paid, cancel, partial and full refunds) and of further capture deliveries for its intent. Afterwards the
// `timeline` `GET /api/orders/:n` serves is, one for one and in order, the order's lifecycle events in the event log:
// each entry's kind is its event's type mapped as the admin history maps it, its `at` within 1 s of the event's.
// `payment.*` and `order.status_changed` events add none. A rebuild of the orders read model serves the same timeline.

/** The event types that are a timeline entry, and the entry each is; every other type is none. */
const LIFECYCLE: Record<string, string> = {
  'order.placed.v1': 'placed',
  'order.paid.v1': 'paid',
  'order.shipped.v1': 'shipped',
  'order.delivered.v1': 'delivered',
  'order.cancelled.v1': 'cancelled',
  'order.partially_refunded.v1': 'partially_refunded',
  'order.refunded.v1': 'refunded',
}

type Command =
  | 'process'
  | 'ship'
  | 'deliver'
  | 'mark-paid'
  | 'cancel'
  | 'partial-refund'
  | 'full-refund'
  | 'capture'

/** The commands the state machine and the refund rules allow at a status. */
function legalAt(status: string, refundableMinor: number): Command[] {
  const refunds: Command[] = [
    ...(refundableMinor >= 2 ? (['partial-refund'] as const) : []),
    ...(refundableMinor >= 1 ? (['full-refund'] as const) : []),
  ]
  switch (status) {
    case 'pending':
      return ['mark-paid', 'cancel', 'capture']
    case 'confirmed':
      return ['process', ...refunds, 'capture']
    case 'processing':
      return ['ship', ...refunds, 'capture']
    case 'shipped':
      return ['deliver', ...refunds, 'capture']
    case 'delivered':
    case 'partially_refunded':
      return [...refunds, 'capture']
    default:
      // cancelled and refunded are terminal; a capture can still arrive for the intent.
      return ['capture']
  }
}

interface ServedOrder {
  id: string
  orderNumber: string
  status: string
  timeline?: Array<{ kind: string; at: string }>
}

const script = fc.record({
  pending: fc.boolean(),
  priceMinor: fc.integer({ min: 300, max: 90_000 }),
  steps: fc.array(fc.tuple(fc.nat({ max: 11 }), fc.integer({ min: 1, max: 60 })), {
    minLength: 1,
    maxLength: 7,
  }),
})

describe('AC-2: the served timeline is the order’s lifecycle events (sqlite)', () => {
  let k: Kernel
  let served: ServedKernel
  let admin: AdminClient
  let raw: RawReader
  let payments: PaymentsAdapter
  let stubRefund: PaymentsAdapter['refund']

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    admin = await adminClient(k, served.baseUrl)
    raw = openRaw(k.dialect, k.target)
    payments = k.app.adapters.payments
    stubRefund = payments.refund.bind(payments)
    // The stub refunds only intents it captured itself; a webhook capture or a manual payment leaves it nothing to
    // refund, so the provider here settles every refund it is asked for, as a real one does for a captured payment.
    payments.refund = async (paymentId, amountMinor, reason, opts) =>
      ({
        refundId: `re_timeline_${randomUUID()}`,
        paymentId,
        amountMinor: amountMinor ?? 0,
        currency: opts?.currency ?? 'GBP',
        reason: reason ?? null,
        status: 'succeeded',
      }) satisfies Refund
  }, 60_000)

  afterAll(async () => {
    if (payments !== undefined) payments.refund = stubRefund
    await raw?.close()
    await served?.stop()
  })

  async function servedOrder(orderNumber: string): Promise<ServedOrder> {
    const res = await fetch(
      new URL(`/api/orders/${encodeURIComponent(orderNumber)}`, served.baseUrl),
    )
    const body = (await res.json()) as { data?: ServedOrder }
    if (res.status !== 200 || body.data === undefined) {
      throw new Error(`GET /api/orders/${orderNumber}: ${res.status} ${JSON.stringify(body)}`)
    }
    return body.data
  }

  /** Waits until the stored document holds every history row the order has, so it reflects the last command. */
  async function caughtUp(orderId: string, orderNumber: string): Promise<ServedOrder> {
    await k.app.relay.drain()
    const rows = await raw.count('order_history', 'order_id = ?', [orderId])
    await vi.waitFor(
      async () => {
        const stored = await k.documentStore.get<{ history: unknown[] }>('orders', orderNumber)
        const held = stored?.history.length ?? 0
        if (held !== rows) throw new Error(`stored history ${held} of ${rows} rows`)
      },
      { timeout: 10_000, interval: 25 },
    )
    return servedOrder(orderNumber)
  }

  /** The order's events in seq order, with their time, from the event log. */
  async function eventsOf(orderId: string): Promise<Array<{ type: string; at: string }>> {
    const rows = await raw.rows<{ type: string; created_at: string }>(
      "SELECT type, created_at FROM events WHERE subject_type = 'order' AND subject_id = ? ORDER BY seq",
      [orderId],
    )
    return rows.map((r) => ({ type: r.type, at: r.created_at }))
  }

  /** Runs one command; a refusal is a broken test setup, not a timeline defect, so it throws with the answer. */
  async function run(
    command: Command,
    order: Awaited<ReturnType<typeof checkoutOf>>,
    refundableMinor: number,
    pct: number,
  ): Promise<void> {
    const path = `/api/admin/orders/${order.orderId}`
    const answer =
      command === 'capture'
        ? await deliverCapture(served.baseUrl, order)
        : await (async () => {
            const res = await admin.call<unknown>(
              'POST',
              command === 'process'
                ? `${path}/process`
                : command === 'ship'
                  ? `${path}/ship`
                  : command === 'deliver'
                    ? `${path}/mark-delivered`
                    : command === 'mark-paid'
                      ? `${path}/mark-paid`
                      : command === 'cancel'
                        ? `${path}/cancel`
                        : `${path}/refund`,
              command === 'ship'
                ? { carrier: 'royal-mail', trackingNumber: `TRK-${randomUUID().slice(0, 8)}` }
                : command === 'partial-refund'
                  ? {
                      amountMinor: Math.max(
                        1,
                        Math.min(refundableMinor - 1, Math.floor((refundableMinor * pct) / 100)),
                      ),
                    }
                  : command === 'full-refund'
                    ? { amountMinor: refundableMinor }
                    : {},
            )
            return { status: res.status, error: res.body.error }
          })()
    if (answer.status !== 200) {
      throw new Error(`${command} answered ${answer.status} ${JSON.stringify(answer.error)}`)
    }
  }

  it('AC-2: property: over random legal command sequences, GET /api/orders/:n’s timeline kinds are the order’s lifecycle events in seq order, each at within 1 s of its event; payment.* and order.status_changed add none; rebuild([orders]) serves an equal timeline', async () => {
    await fc.assert(
      fc.asyncProperty(script, async ({ pending, priceMinor, steps }) => {
        const seeded = await seedVariant(k, 2, { priceMinor })
        const email = `timeline-${randomUUID()}${pending ? '+stub-pending' : ''}@timeline.test`
        const order = await checkoutOf(k, seeded, 1, email)
        await caughtUp(order.orderId, order.orderNumber)

        for (const [pick, pct] of steps) {
          const read = await adminOrder(admin, order.orderNumber)
          const refundable = read.payment?.refundableMinor ?? 0
          const legal = legalAt(read.status, refundable)
          await run(legal[pick % legal.length]!, order, refundable, pct)
          await caughtUp(order.orderId, order.orderNumber)
        }

        const doc = await caughtUp(order.orderId, order.orderNumber)
        const events = await eventsOf(order.orderId)
        const lifecycle = events.filter((e) => LIFECYCLE[e.type] !== undefined)

        expect(
          doc.timeline?.map((e) => e.kind),
          `events: ${events.map((e) => e.type).join(', ')}`,
        ).toEqual(lifecycle.map((e) => LIFECYCLE[e.type]))
        for (const [i, entry] of (doc.timeline ?? []).entries()) {
          expect(
            Math.abs(Date.parse(entry.at) - Date.parse(lifecycle[i]!.at)),
            `entry ${i} (${entry.kind}) at ${entry.at}, event ${lifecycle[i]!.type} at ${lifecycle[i]!.at}`,
          ).toBeLessThanOrEqual(1_000)
        }

        await rebuild(['orders'], rebuildDeps(k))
        expect((await servedOrder(order.orderNumber)).timeline, 'after rebuild([orders])').toEqual(
          doc.timeline,
        )
      }),
      { numRuns: 25 },
    )
  }, 240_000)
})
