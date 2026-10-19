import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'
import { orderStatus, paidFor } from '../support/webhooks.js'

// P1-05 AC-1 and AC-2: the Stripe webhook contract, byte for byte, through the real Fastify adapter on the Stripe
// adapter with a test webhook secret. The pending order is created without calling Stripe: only the webhook path is
// under test. Kills: a route that re-serialises the parsed body instead of verifying the bytes Stripe signed (AC-1), a
// signature failure rendered 500 (AC-2), and a raw-body parser that drops Fastify's JSON semantics (AC-2).

const WEBHOOK_SECRET = 'whsec_p1_05_contract_secret'
const signer = new Stripe('sk_test_p1_05_never_called')

function stripePayments(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: {
      ...config.commerce,
      payments: {
        provider: 'stripe',
        config: { secretKey: 'sk_test_p1_05_never_called', webhookSecret: WEBHOOK_SECRET },
      },
    },
  }
}

interface Pending {
  orderId: string
  intentId: string
  totalMinor: number
  currency: string
  variantId: string
  initialStock: number
  qty: number
}

describe('Stripe webhook contract (HTTP, Stripe adapter)', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite', configure: stripePayments })
    expect(k.app.adapters.payments.providerName).toBe('stripe')
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  /** A pending order for `intentId` with one reserved line, created through the kernel, with no Stripe call. */
  async function pendingOrder(intentId: string): Promise<Pending> {
    const qty = 1
    const seeded = await seedVariant(k, 4, { priceMinor: 2599 })
    const orderId = uuidv7()
    const order = await k.store.transaction(async (tx) => {
      const reservation = await k.services.inventory.reserveStock(seeded.variantId, qty, orderId)
      const created = await k.services.order.createFromCheckout({
        orderId,
        customerId: null,
        email: `contract-${randomUUID()}@p1-05.test`,
        billingAddress: address,
        shippingAddress: address,
        lineItems: [
          {
            variantId: seeded.variantId,
            productId: seeded.productId,
            productName: 'Transactional Widget',
            variantName: 'Default',
            sku: '',
            qty,
            unitPriceMinor: seeded.priceMinor,
            lineSubtotalMinor: seeded.priceMinor * qty,
            lineTaxMinor: 0,
            lineTotalMinor: seeded.priceMinor * qty,
            imageUrl: '',
          },
        ],
        subtotalMinor: seeded.priceMinor * qty,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor: seeded.priceMinor * qty,
        currency: k.config.store.currency,
        metadata: { cartToken: '', reservationIds: [reservation.reservationId] },
      })
      await k.repos.order.setPaymentIntent(tx, created.id, intentId, new Date())
      return created
    })
    return {
      orderId: order.id,
      intentId,
      totalMinor: order.totalMinor,
      currency: order.currency,
      variantId: seeded.variantId,
      initialStock: seeded.initialStock,
      qty,
    }
  }

  /**
   * A payment_intent.succeeded event, pretty-printed with a two-space indent and carrying a backslash-u escape as
   * the six ASCII bytes. JSON.stringify of its parse differs in whitespace and in the escape, so only the exact
   * bytes verify.
   */
  function signedPayload(pending: Pending): string {
    const event = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      object: 'event',
      api_version: '2025-02-24.acacia',
      created: Math.floor(Date.now() / 1000),
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: pending.intentId,
          object: 'payment_intent',
          amount: pending.totalMinor,
          amount_received: pending.totalMinor,
          currency: pending.currency.toLowerCase(),
          status: 'succeeded',
          description: 'Café order',
        },
      },
    }
    const pretty = JSON.stringify(event, null, 2)
    expect(pretty).toContain('é')
    const payload = pretty.replace('é', '\\u00e9')
    expect(payload).toContain('\\u00e9')
    expect(payload).not.toBe(JSON.stringify(JSON.parse(payload)))
    return payload
  }

  async function post(body: string, signature: string) {
    const res = await fetch(new URL('/api/webhooks/stripe', served.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body,
    })
    const text = await res.text()
    return {
      status: res.status,
      body: (text === '' ? {} : JSON.parse(text)) as {
        data?: Record<string, unknown>
        error?: { code: string }
      },
    }
  }

  it('AC-1: a pretty-printed payload with a \\u escape, signed over its exact bytes, answers 200 finalized: true and confirms the order', async () => {
    const pending = await pendingOrder(`pi_x_${randomUUID().replace(/-/g, '')}`)
    const payload = signedPayload(pending)
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })

    const answer = await post(payload, header)

    expect(answer.status).toBe(200)
    expect(answer.body.data?.finalized).toBe(true)
    expect(await orderStatus(raw, pending.orderId)).toBe('confirmed')
    expect(await stockOf(raw, pending.variantId)).toBe(pending.initialStock - pending.qty)
    expect(await paidFor(raw, pending.orderId)).toHaveLength(1)
  })

  it('AC-2: a signature from another secret gets 400 webhook.invalid and the order stays pending', async () => {
    const pending = await pendingOrder(`pi_forged_${randomUUID().replace(/-/g, '')}`)
    const payload = signedPayload(pending)
    const forged = signer.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_somebody_elses_secret',
    })

    const answer = await post(payload, forged)

    expect(answer.status).toBe(400)
    expect(answer.body.error?.code).toBe('webhook.invalid')
    expect(await orderStatus(raw, pending.orderId)).toBe('pending')
    expect(await paidFor(raw, pending.orderId)).toEqual([])
  })

  it('AC-2: a body changed by one byte after signing gets 400 webhook.invalid and the order stays pending', async () => {
    const pending = await pendingOrder(`pi_tampered_${randomUUID().replace(/-/g, '')}`)
    const payload = signedPayload(pending)
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
    const tampered = payload.replace('"status": "succeeded"', '"status": "succeedeD"')
    expect(tampered).toHaveLength(payload.length)
    expect(tampered).not.toBe(payload)

    const answer = await post(tampered, header)

    expect(answer.status).toBe(400)
    expect(answer.body.error?.code).toBe('webhook.invalid')
    expect(await orderStatus(raw, pending.orderId)).toBe('pending')
  })

  it('AC-2: on a non-webhook JSON route, a malformed body and a __proto__ body each get 400, never a parse that reaches the handler or a 500', async () => {
    async function postCart(body: string): Promise<number> {
      const res = await fetch(new URL('/api/cart/items', served.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      await res.text()
      return res.status
    }
    expect(await postCart('{"variantId": ')).toBe(400)
    expect(await postCart('{"__proto__": {"polluted": true}, "variantId": "v", "qty": 1}')).toBe(
      400,
    )
    expect(await postCart('')).toBe(400)
    // Fastify's parser must still be in front of the route: a well-formed body gets past it to the route's own
    // refusal, which is not a parser status.
    expect(await postCart('{"variantId": "v", "qty": 1}')).not.toBe(500)
  })
})
