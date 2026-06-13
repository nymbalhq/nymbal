import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runPaymentsContract } from '@nymbal/contract-tests'
import { createLogger, createStripePaymentsAdapter } from '@nymbal/platform'
import { PaymentError } from '@nymbal/types'

const SECRET_KEY = 'sk_test_mock'
const WEBHOOK_SECRET = 'whsec_test_mock'

/**
 * Minimal in-process mock of the Stripe REST API covering exactly the calls
 * the Stripe payments adapter makes. Request bodies are form-encoded (that is
 * what stripe-node sends) and the mock honours the amount/currency the
 * adapter sent — nothing the contract asserts is hardcoded here.
 */

/** Stripe wire shape (provider boundary), not a Nymbal domain type. */
interface MockStripeIntent {
  id: string
  object: 'payment_intent'
  amount: number
  amount_received: number | null
  client_secret: string
  currency: string
  status: 'requires_payment_method' | 'succeeded'
  metadata: Record<string, string>
}

const intents = new Map<string, MockStripeIntent>()
let seq = 0

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendStripeError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: { type: 'invalid_request_error', message } })
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function metadataFromParams(params: URLSearchParams): Record<string, string> {
  const metadata: Record<string, string> = {}
  for (const [key, value] of params) {
    const match = /^metadata\[(.+)\]$/.exec(key)
    if (match) metadata[match[1]!] = value
  }
  return metadata
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization
  if (auth !== `Bearer ${SECRET_KEY}`) {
    sendJson(res, 401, { error: { type: 'invalid_request_error', message: 'Invalid API key' } })
    return
  }
  const path = (req.url ?? '').split('?')[0] ?? ''
  const method = req.method ?? 'GET'
  const body = await readBody(req)
  const params = new URLSearchParams(body)

  if (method === 'POST' && path === '/v1/payment_intents') {
    const amountRaw = params.get('amount')
    const currency = params.get('currency')
    if (amountRaw === null || currency === null) {
      sendStripeError(res, 400, 'Missing required param: amount or currency')
      return
    }
    seq += 1
    const id = `pi_${seq}`
    const intent: MockStripeIntent = {
      id,
      object: 'payment_intent',
      amount: Number(amountRaw),
      amount_received: 0,
      client_secret: `${id}_secret_${seq}`,
      currency,
      status: 'requires_payment_method',
      metadata: metadataFromParams(params),
    }
    intents.set(id, intent)
    sendJson(res, 200, intent)
    return
  }

  const captureMatch = /^\/v1\/payment_intents\/([^/]+)\/capture$/.exec(path)
  if (method === 'POST' && captureMatch) {
    const intent = intents.get(captureMatch[1]!)
    if (!intent) {
      sendStripeError(res, 404, `No such payment_intent: '${captureMatch[1]!}'`)
      return
    }
    const amountToCapture = params.get('amount_to_capture')
    intent.status = 'succeeded'
    intent.amount_received = amountToCapture !== null ? Number(amountToCapture) : intent.amount
    sendJson(res, 200, intent)
    return
  }

  const retrieveMatch = /^\/v1\/payment_intents\/([^/]+)$/.exec(path)
  if (method === 'GET' && retrieveMatch) {
    const intent = intents.get(retrieveMatch[1]!)
    if (!intent) {
      sendStripeError(res, 404, `No such payment_intent: '${retrieveMatch[1]!}'`)
      return
    }
    sendJson(res, 200, intent)
    return
  }

  if (method === 'POST' && path === '/v1/refunds') {
    const paymentIntentId = params.get('payment_intent')
    const intent = paymentIntentId === null ? undefined : intents.get(paymentIntentId)
    if (!intent) {
      sendStripeError(res, 404, `No such payment_intent: '${paymentIntentId ?? ''}'`)
      return
    }
    const amountRaw = params.get('amount')
    seq += 1
    sendJson(res, 200, {
      id: `re_${seq}`,
      object: 'refund',
      amount: amountRaw !== null ? Number(amountRaw) : intent.amount,
      currency: intent.currency,
      payment_intent: intent.id,
      reason: params.get('reason'),
      status: 'succeeded',
    })
    return
  }

  if (method === 'GET' && path === '/v1/balance') {
    sendJson(res, 200, {
      object: 'balance',
      available: [{ amount: 0, currency: 'gbp', source_types: { card: 0 } }],
      pending: [{ amount: 0, currency: 'gbp', source_types: { card: 0 } }],
      livemode: false,
    })
    return
  }

  sendStripeError(res, 404, `Unrecognized request URL (${method}: ${path})`)
}

const server: Server = createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.error('mock stripe server error', err)
    sendStripeError(res, 500, 'mock stripe server error')
  })
})

let port = 0
let closedPort = 0

beforeAll(async () => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port

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
  server.close()
  await once(server, 'close')
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

runPaymentsContract(buildAdapter)

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
