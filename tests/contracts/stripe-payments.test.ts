import { createServer, type IncomingMessage, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { createStripePaymentsAdapter } from '@nymbalhq/payments-stripe'
import { createLogger } from '@nymbalhq/platform'
import { PaymentError } from '@nymbalhq/types'
import { startStripeFake, type StripeFake } from '../fixtures/stripe-api/server.mjs'

const SECRET_KEY = 'sk_test_mock'
const WEBHOOK_SECRET = 'whsec_test_mock'

// The offline Stripe API (tests/fixtures/stripe-api/server.mjs), on loopback: what the adapter calls, as Stripe answers.
let fake: StripeFake
let port = 0
let closedPort = 0

beforeAll(async () => {
  fake = await startStripeFake({ host: '127.0.0.1', secretKey: SECRET_KEY })
  port = fake.port

  // Reserve and release a second ephemeral port so the "provider down" tests
  // have an address that refuses connections.
  const throwaway = createServer()
  throwaway.listen(0, '127.0.0.1')
  await once(throwaway, 'listening')
  closedPort = (throwaway.address() as AddressInfo).port
  throwaway.close()
  await once(throwaway, 'close')
})

afterAll(async () => {
  await fake.close()
})

const logger = createLogger({ pretty: false, level: 'error' })

function buildAdapter() {
  return createStripePaymentsAdapter({
    logger,
    config: {
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      host: '127.0.0.1',
      port,
      protocol: 'http',
    },
  })
}

// AC-4 and AC-5: the refund idempotency case against the mock's replay, parsing one signed webhook twice, and the
// downtime cases on a port nobody listens on.
runPaymentsContract('stripe', buildAdapter, {
  unreachable: () =>
    createStripePaymentsAdapter({
      logger,
      config: {
        secretKey: SECRET_KEY,
        webhookSecret: WEBHOOK_SECRET,
        host: '127.0.0.1',
        port: closedPort,
        protocol: 'http',
      },
    }),
  signedWebhook: () => {
    const rawBody = JSON.stringify({
      id: 'evt_contract_contracts',
      object: 'event',
      api_version: '2025-02-24.acacia',
      created: Math.floor(Date.now() / 1000),
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_webhook_contracts',
          object: 'payment_intent',
          amount: 1234,
          amount_received: 1234,
          currency: 'gbp',
          status: 'succeeded',
        },
      },
    })
    const signature = new Stripe(SECRET_KEY).webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: WEBHOOK_SECRET,
    })
    return { rawBody, signature }
  },
})

describe('Stripe payments adapter against the mock Stripe API', () => {
  it('captures the full amount and reports succeeded status', async () => {
    const adapter = buildAdapter()
    const intent = await adapter.createPaymentIntent({
      amountMinor: 2599,
      currency: 'GBP',
      orderRef: 'order-capture-1',
    })
    expect(intent.status).toBe('requires_payment_method')

    const capture = await adapter.capturePayment(intent.id)
    expect(capture).toEqual({
      paymentId: intent.id,
      capturedAmountMinor: 2599,
      currency: 'GBP',
      status: 'succeeded',
    })
    await expect(adapter.getPaymentStatus(intent.id)).resolves.toBe('succeeded')
  })

  it('captures a partial amount when amountMinor is provided', async () => {
    const adapter = buildAdapter()
    const intent = await adapter.createPaymentIntent({ amountMinor: 5000, currency: 'GBP' })
    const capture = await adapter.capturePayment(intent.id, 1500)
    expect(capture.capturedAmountMinor).toBeLessThan(intent.amountMinor)
    expect(capture.capturedAmountMinor).toBe(1500)
    expect(capture.status).toBe('succeeded')
  })

  it('refunds a specific amount with a reason', async () => {
    const adapter = buildAdapter()
    const intent = await adapter.createPaymentIntent({ amountMinor: 4200, currency: 'GBP' })
    await adapter.capturePayment(intent.id)
    const refund = await adapter.refund(intent.id, 1000, 'requested_by_customer')
    expect(refund.refundId).toMatch(/^re_\d+$/)
    expect(refund).toEqual({
      refundId: refund.refundId,
      paymentId: intent.id,
      amountMinor: 1000,
      currency: 'GBP',
      reason: 'requested_by_customer',
      status: 'succeeded',
    })
  })

  it('refunds the full intent amount when no amount is given', async () => {
    const adapter = buildAdapter()
    const intent = await adapter.createPaymentIntent({ amountMinor: 3100, currency: 'GBP' })
    await adapter.capturePayment(intent.id)
    const refund = await adapter.refund(intent.id)
    expect(refund.amountMinor).toBe(3100)
    expect(refund.reason).toBeNull()
    expect(refund.status).toBe('succeeded')
  })

  it('wraps a provider rejection (unknown intent) in PaymentError capture_failed', async () => {
    const adapter = buildAdapter()
    const error = await adapter
      .capturePayment('pi_does_not_exist')
      .then(() => null)
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe('payment.capture_failed')
  })

  it('reports down from healthCheck when the provider is unreachable', async () => {
    const downAdapter = createStripePaymentsAdapter({
      logger,
      config: {
        secretKey: SECRET_KEY,
        webhookSecret: WEBHOOK_SECRET,
        host: '127.0.0.1',
        port: closedPort,
        protocol: 'http',
      },
    })
    const report = await downAdapter.healthCheck()
    expect(report.status).toBe('down')
    expect(report.detail).toBeTruthy()
  })

  it('wraps provider downtime in PaymentError intent_failed', async () => {
    const downAdapter = createStripePaymentsAdapter({
      logger,
      config: {
        secretKey: SECRET_KEY,
        webhookSecret: WEBHOOK_SECRET,
        host: '127.0.0.1',
        port: closedPort,
        protocol: 'http',
      },
    })
    const error = await downAdapter
      .createPaymentIntent({ amountMinor: 1000, currency: 'GBP' })
      .then(() => null)
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe('payment.intent_failed')
  })
})

describe('Stripe payments adapter webhooks (signed locally, no network)', () => {
  // Used only for its webhook signing utility — it never makes a request.
  const signer = new Stripe(SECRET_KEY)

  const succeededPayload = JSON.stringify({
    id: 'evt_contract_1',
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_webhook_1',
        object: 'payment_intent',
        amount: 1234,
        amount_received: 1234,
        currency: 'gbp',
        status: 'succeeded',
      },
    },
  })

  it('parses a genuinely signed payment_intent.succeeded event as payment.captured', async () => {
    const adapter = buildAdapter()
    const header = signer.webhooks.generateTestHeaderString({
      payload: succeededPayload,
      secret: WEBHOOK_SECRET,
    })
    const result = await adapter.parseWebhook(succeededPayload, header)
    expect(result.verified).toBe(true)
    expect(result.eventId).toBe('evt_contract_1')
    expect(result.kind).toBe('payment.captured')
    expect(result.paymentIntentId).toBe('pi_webhook_1')
    expect(result.amountMinor).toBe(1234)
    expect(result.currency).toBe('GBP')
  })

  it('parses the same signed event twice with identical results (idempotent)', async () => {
    const adapter = buildAdapter()
    const header = signer.webhooks.generateTestHeaderString({
      payload: succeededPayload,
      secret: WEBHOOK_SECRET,
    })
    const first = await adapter.parseWebhook(succeededPayload, header)
    const second = await adapter.parseWebhook(succeededPayload, header)
    expect(second).toEqual(first)
  })

  it('throws PaymentError webhook_invalid when the payload is signed with the wrong secret', async () => {
    const adapter = buildAdapter()
    const forgedHeader = signer.webhooks.generateTestHeaderString({
      payload: succeededPayload,
      secret: 'whsec_wrong_secret',
    })
    const error = await adapter
      .parseWebhook(succeededPayload, forgedHeader)
      .then(() => null)
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe('payment.webhook_invalid')
  })

  it('throws PaymentError webhook_invalid for a malformed signature header', async () => {
    const adapter = buildAdapter()
    const error = await adapter
      .parseWebhook(succeededPayload, 'not-a-stripe-signature')
      .then(() => null)
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe('payment.webhook_invalid')
  })
})

describe('the fake Stripe API delivers the webhook a confirm causes', () => {
  /** A stand-in for the store's webhook endpoint: keeps each delivery's raw body and signature, answers 200. */
  async function receiver(): Promise<{
    url: string
    deliveries: Array<{ rawBody: string; signature: string }>
    close(): Promise<void>
  }> {
    const deliveries: Array<{ rawBody: string; signature: string }> = []
    const server: Server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        deliveries.push({
          rawBody: Buffer.concat(chunks).toString('utf8'),
          signature: String(req.headers['stripe-signature'] ?? ''),
        })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
      deliveries,
      async close() {
        server.close()
        await once(server, 'close')
      },
    }
  }

  it("a confirm with the intent's client_secret, as Stripe.js sends it, posts one payment_intent.succeeded signed with the webhook secret, which the adapter verifies as the capture of that intent's amount, currency and metadata", async () => {
    const hook = await receiver()
    const delivering = await startStripeFake({
      host: '127.0.0.1',
      secretKey: SECRET_KEY,
      webhookUrl: hook.url,
      webhookSecret: WEBHOOK_SECRET,
    })
    try {
      const adapter = createStripePaymentsAdapter({
        logger,
        config: {
          secretKey: SECRET_KEY,
          webhookSecret: WEBHOOK_SECRET,
          host: '127.0.0.1',
          port: delivering.port,
          protocol: 'http',
        },
      })
      const intent = await adapter.createPaymentIntent({
        amountMinor: 1875,
        currency: 'GBP',
        orderRef: 'order-confirm-1',
      })
      const before = hook.deliveries.length

      const confirmed = await fetch(`${delivering.url}/v1/payment_intents/${intent.id}/confirm`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer pk_test_storefront',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ client_secret: intent.clientSecret }).toString(),
      })
      const answer = (await confirmed.json()) as { status?: string; amount_received?: number }
      const delivered = hook.deliveries.slice(before)
      const parsed = await adapter.parseWebhook(delivered[0]!.rawBody, delivered[0]!.signature)
      const event = JSON.parse(delivered[0]!.rawBody) as {
        data: { object: { metadata?: Record<string, string> } }
      }

      expect(confirmed.status, JSON.stringify(answer)).toBe(200)
      expect(answer.amount_received).toBe(intent.amountMinor)
      expect(delivered).toHaveLength(1)
      expect(parsed.verified).toBe(true)
      expect(parsed.kind).toBe('payment.captured')
      expect(parsed.paymentIntentId).toBe(intent.id)
      expect(parsed.amountMinor).toBe(intent.amountMinor)
      expect(parsed.currency).toBe(intent.currency)
      expect(event.data.object.metadata?.['orderRef']).toBe('order-confirm-1')
      await expect(adapter.getPaymentStatus(intent.id)).resolves.toBe('succeeded')
    } finally {
      await delivering.close()
      await hook.close()
    }
  })
})
