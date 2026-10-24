import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_CART_CONVERTED,
  EVT_INVENTORY_CHANGED,
  EVT_INVENTORY_RELEASED,
  EVT_INVENTORY_RESERVED,
  EVT_ORDER_PAID,
  EVT_ORDER_PLACED,
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_FAILED,
} from '@nymbalhq/types'
import {
  correlationIdsOf,
  DECISION_3,
  eventsAfter,
  payloadOf,
  send,
  type Answer,
} from '../correlation.js'
import { address, type Dialect } from '../kernel.js'
import { maxSeq, type EventRow } from '../outbox.js'
import { stubPaymentWebhook, type TestStore } from '../proof-kit.js'
import type { RawReader } from '../raw.js'
import { shopper } from '../shopper.js'

// AC-1 and AC-1b on one dialect: a shopper checks out over HTTP on startTestStore (stub payments, `+stub-pending` so
// the order waits for its webhook), then the stub webhook arrives as a request of its own. AC-1: every event from POST
// /api/checkout through the webhook's confirm carries the checkout response's x-correlation-id, and the webhook
// response's own id differs. AC-1b: a failed payment, a capture for the wrong amount, and a webhook for an intent no
// order holds. Events are read from the `events` table through a second connection, by seq: nothing else publishes
// on the store while a case runs (no sweeper is due).

interface Line {
  priceMinor: number
  qty: number
}

interface Placed {
  orderId: string
  paymentIntent: { id: string }
  totalMinor: number
  currency: string
}

interface Harness {
  store: TestStore
  raw: RawReader
  stop(): Promise<void>
}

function webhook(baseUrl: string, opts: Parameters<typeof stubPaymentWebhook>[0]): Promise<Answer> {
  return send(baseUrl, stubPaymentWebhook(opts))
}

function headerIsValid(answer: { correlationId: string | null }): boolean {
  return answer.correlationId !== null && DECISION_3.test(answer.correlationId)
}

function ofType(rows: EventRow[], type: string, where: Record<string, unknown> = {}): EventRow[] {
  return rows.filter(
    (row) =>
      row.type === type &&
      Object.entries(where).every(([key, value]) => payloadOf(row)[key] === value),
  )
}

export function checkoutCorrelationSuite(
  dialect: Dialect,
  start: () => Promise<Harness>,
  opts: { runs: number },
): void {
  describe(`AC-1 and AC-1b: one checkout, one correlation id (${dialect})`, () => {
    let h: Harness

    beforeAll(async () => {
      h = await start()
    }, 90_000)

    afterAll(async () => {
      await h?.stop()
    })

    /** A cart holding `lines` (one fresh variant each, stock 20) and its pending checkout, over HTTP. */
    async function checkout(lines: Line[], tag: string) {
      const variants = []
      for (const [i, line] of lines.entries()) {
        const product = await h.store.app.services.product.create({
          slug: `events-${tag}-${i}`,
          name: `Correlated ${i}`,
          description: '',
          status: 'active',
          variants: [
            {
              sku: `P301-${tag}-${i}`,
              name: 'Default',
              priceMinor: line.priceMinor,
              stock: 20,
              options: [],
            },
          ],
        })
        variants.push({ variantId: product.variants[0]!.id, qty: line.qty })
      }
      const s = shopper(h.store.baseUrl)
      expect((await s.call('GET', '/api/cart')).status).toBe(200)
      for (const v of variants) {
        const added = await s.call('POST', '/api/cart/items', v)
        expect(added.status, JSON.stringify(added.body)).toBe(200)
      }
      const before = await maxSeq(h.raw)
      const res = await s.call<Placed>('POST', '/api/checkout', {
        email: `ac1-${tag}+stub-pending@events.test`,
        billingAddress: address,
        shippingAddress: address,
      })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return {
        before,
        placed: res.body.data!,
        correlationId: res.headers.get('x-correlation-id'),
        afterCheckout: await maxSeq(h.raw),
      }
    }

    it(`AC-1: property (${opts.runs} carts of 1-4 lines): every event from POST /api/checkout through the webhook's confirm carries one correlation id, the checkout response's x-correlation-id; the webhook response's own id differs`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              priceMinor: fc.integer({ min: 100, max: 5000 }),
              qty: fc.integer({ min: 1, max: 3 }),
            }),
            { minLength: 1, maxLength: 4 },
          ),
          async (lines) => {
            const tag = randomUUID()
            const c = await checkout(lines, tag)
            const hook = await webhook(h.store.baseUrl, {
              paymentIntentId: c.placed.paymentIntent.id,
              amountMinor: c.placed.totalMinor,
              currency: c.placed.currency,
            })
            expect(hook.status, JSON.stringify(hook.body)).toBe(200)
            expect((hook.body as { data?: { finalized?: boolean } }).data?.finalized).toBe(true)

            const events = await eventsAfter(h.raw, c.before)
            const fromWebhook = events.filter((e) => e.seq > c.afterCheckout)
            const ids = correlationIdsOf(events)
            // The checkout's events and the webhook's: what one operator query must return.
            expect(
              ofType(events, EVT_INVENTORY_RESERVED).length,
              'inventory.reserved, one per line',
            ).toBe(lines.length)
            expect(ofType(events, EVT_INVENTORY_CHANGED).length).toBeGreaterThanOrEqual(
              lines.length,
            )
            expect(
              ofType(events, EVT_INVENTORY_RELEASED, { reason: 'committed' }).length,
              'inventory.released (committed), one per line',
            ).toBe(lines.length)
            const placed = ofType(events, EVT_ORDER_PLACED).filter(
              (row) =>
                (payloadOf(row)['order'] as { id?: string } | undefined)?.id === c.placed.orderId,
            )
            expect(
              [EVT_PAYMENT_CAPTURED, EVT_ORDER_PAID, EVT_CART_CONVERTED].map(
                (type) => ofType(events, type, { orderId: c.placed.orderId }).length,
              ),
              'payment.captured, order.paid, cart.converted for the order',
            ).toEqual([1, 1, 1])
            expect(placed.length, 'order.placed for the order').toBe(1)
            expect(fromWebhook.length).toBeGreaterThan(0)

            expect(
              [...new Set(ids)],
              `distinct correlation ids across the checkout's ${events.length} events`,
            ).toHaveLength(1)
            expect(headerIsValid(c), `checkout x-correlation-id: ${c.correlationId}`).toBe(true)
            expect(ids).toEqual(events.map(() => c.correlationId))
            expect(headerIsValid(hook), `webhook x-correlation-id: ${hook.correlationId}`).toBe(
              true,
            )
            expect(hook.correlationId === c.correlationId, 'the webhook has an id of its own').toBe(
              false,
            )
          },
        ),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 180_000)

    it('AC-1b (a): a checkout whose webhook is a payment failure: the payment.failed it publishes carries the checkout response’s x-correlation-id, not the webhook’s', async () => {
      const c = await checkout([{ priceMinor: 1200, qty: 1 }], randomUUID())
      const hook = await webhook(h.store.baseUrl, {
        paymentIntentId: c.placed.paymentIntent.id,
        amountMinor: c.placed.totalMinor,
        currency: c.placed.currency,
        kind: 'payment.failed',
      })
      expect(hook.status, JSON.stringify(hook.body)).toBe(200)

      const fromWebhook = await eventsAfter(h.raw, c.afterCheckout)
      const failed = ofType(fromWebhook, EVT_PAYMENT_FAILED, { orderId: c.placed.orderId })
      expect(failed.length, 'payment.failed for the order').toBe(1)
      expect(correlationIdsOf(fromWebhook), 'every event the webhook published').toEqual(
        fromWebhook.map(() => c.correlationId),
      )
      expect(headerIsValid(c), `checkout x-correlation-id: ${c.correlationId}`).toBe(true)
      expect(hook.correlationId === c.correlationId, 'the webhook has an id of its own').toBe(false)
    }, 60_000)

    it('AC-1b (b): a capture for an amount other than the order total: payment.failed and every other outcome event carry the checkout response’s x-correlation-id, not the webhook’s', async () => {
      const c = await checkout(
        [
          { priceMinor: 900, qty: 2 },
          { priceMinor: 450, qty: 1 },
        ],
        randomUUID(),
      )
      const hook = await webhook(h.store.baseUrl, {
        paymentIntentId: c.placed.paymentIntent.id,
        amountMinor: c.placed.totalMinor + 1,
        currency: c.placed.currency,
      })
      expect(hook.status, JSON.stringify(hook.body)).toBe(200)
      expect((hook.body as { data?: { finalized?: boolean } }).data?.finalized).toBe(false)

      const fromWebhook = await eventsAfter(h.raw, c.afterCheckout)
      expect(
        ofType(fromWebhook, EVT_PAYMENT_FAILED, { orderId: c.placed.orderId }).length,
        'payment.failed for the order (amount_mismatch)',
      ).toBe(1)
      expect(correlationIdsOf(fromWebhook), 'every outcome event the webhook published').toEqual(
        fromWebhook.map(() => c.correlationId),
      )
      expect(headerIsValid(c), `checkout x-correlation-id: ${c.correlationId}`).toBe(true)
      expect(hook.correlationId === c.correlationId, 'the webhook has an id of its own').toBe(false)
    }, 60_000)

    it('AC-1b: a payment-failure webhook for an intent no order holds publishes under the webhook request’s own x-correlation-id', async () => {
      const intent = `pi_unknown_${randomUUID()}`
      const before = await maxSeq(h.raw)
      const hook = await webhook(h.store.baseUrl, {
        paymentIntentId: intent,
        amountMinor: 1000,
        currency: 'GBP',
        kind: 'payment.failed',
      })
      expect(hook.status, JSON.stringify(hook.body)).toBe(200)

      const events = await eventsAfter(h.raw, before)
      expect(ofType(events, EVT_PAYMENT_FAILED, { paymentId: intent }).length).toBe(1)
      expect(headerIsValid(hook), `webhook x-correlation-id: ${hook.correlationId}`).toBe(true)
      expect(correlationIdsOf(events)).toEqual(events.map(() => hook.correlationId))
    }, 60_000)
  })
}
