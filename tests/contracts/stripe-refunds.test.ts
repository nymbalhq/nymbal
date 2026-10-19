import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogger, createStripePaymentsAdapter } from '@nymbalhq/platform'
import { PaymentError, type PaymentsAdapter } from '@nymbalhq/types'

// P1-13 AC-4 (decision 4, B2) for the Stripe adapter, through the real stripe-node client against an in-process mock of
// POST /v1/refunds. The idempotency key the service passes (the refund row's id) reaches Stripe as the Idempotency-Key
// request header, so a retry of one row cannot refund twice; a definite refusal (a card error, an invalid request) is
// `refund_rejected`; an outcome the shop cannot know (an API error, a refused connection) is `refund_unknown`. Kills: no
// idempotency key sent, and every failure wrapped as one code, so a timeout settles as failed and is refunded again.

const SECRET_KEY = 'sk_test_mock'
const WEBHOOK_SECRET = 'whsec_test_mock'

/** What each refund request carried, by payment intent. */
const seen = new Map<string, Array<{ idempotencyKey: string | undefined; amount: string | null }>>()

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(statusCode, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** The intent id's prefix picks Stripe's answer: ok, a card error, an invalid request, or an API error. */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const params = new URLSearchParams(await readBody(req))
  if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/refunds') {
    sendJson(res, 404, { error: { type: 'invalid_request_error', message: 'unrecognized' } })
    return
  }
  const intent = params.get('payment_intent') ?? ''
  const key = req.headers['idempotency-key']
  const list = seen.get(intent) ?? []
  list.push({ idempotencyKey: Array.isArray(key) ? key[0] : key, amount: params.get('amount') })
  seen.set(intent, list)
  // Stripe never asks for a retry of these; the header keeps stripe-node from retrying them.
  const noRetry = { 'stripe-should-retry': 'false' }
  if (intent.startsWith('pi_card_')) {
    sendJson(
      res,
      402,
      { error: { type: 'card_error', code: 'card_declined', message: 'refund declined' } },
      noRetry,
    )
    return
  }
  if (intent.startsWith('pi_invalid_')) {
    sendJson(
      res,
      400,
      { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'no' } },
      noRetry,
    )
    return
  }
  if (intent.startsWith('pi_api_')) {
    sendJson(res, 500, { error: { type: 'api_error', message: 'Stripe had a problem' } }, noRetry)
    return
  }
  sendJson(res, 200, {
    id: `re_${randomUUID().replace(/-/g, '')}`,
    object: 'refund',
    amount: Number(params.get('amount') ?? '0'),
    currency: 'gbp',
    payment_intent: intent,
    reason: params.get('reason'),
    status: 'succeeded',
  })
}

const server: Server = createServer((req, res) => {
  handleRequest(req, res).catch(() => sendJson(res, 500, { error: { type: 'api_error' } }))
})

let port = 0
let closedPort = 0

beforeAll(async () => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
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

function adapter(on = port): PaymentsAdapter {
  return createStripePaymentsAdapter({
    logger,
    config: {
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      host: '127.0.0.1',
      port: on,
      protocol: 'http',
    },
  })
}

async function codeOf(call: Promise<unknown>): Promise<string | null> {
  return call.then(
    () => null,
    (err: unknown) => (err instanceof PaymentError ? err.code : `not a PaymentError: ${String(err)}`),
  )
}

describe('Stripe adapter refunds (AC-4)', () => {
  it('AC-4: the idempotency key reaches Stripe as the Idempotency-Key header, the same key on every call for one refund row, a different key for another row', async () => {
    const stripe = adapter()
    const intent = `pi_ok_${randomUUID()}`
    const rowA = randomUUID()
    const rowB = randomUUID()

    const first = await stripe.refund(intent, 700, 'requested_by_customer', { idempotencyKey: rowA })
    await stripe.refund(intent, 700, 'requested_by_customer', { idempotencyKey: rowA })
    await stripe.refund(intent, 300, 'requested_by_customer', { idempotencyKey: rowB })

    expect(first.amountMinor).toBe(Number(seen.get(intent)?.[0]?.amount))
    expect(seen.get(intent)?.map((r) => [r.idempotencyKey, r.amount])).toEqual([
      [rowA, '700'],
      [rowA, '700'],
      [rowB, '300'],
    ])
  })

  it('AC-4: a definite refusal is refund_rejected: a card error and an invalid request', async () => {
    const stripe = adapter()
    for (const prefix of ['pi_card_', 'pi_invalid_']) {
      const code = await codeOf(
        stripe.refund(`${prefix}${randomUUID()}`, 500, 'requested_by_customer', {
          idempotencyKey: randomUUID(),
        }),
      )
      expect(code, prefix).toBe('payment.refund_rejected')
    }
  })

  it('AC-4: an outcome the shop cannot know is refund_unknown: a Stripe API error and a refused connection', async () => {
    const apiError = await codeOf(
      adapter().refund(`pi_api_${randomUUID()}`, 500, 'requested_by_customer', {
        idempotencyKey: randomUUID(),
      }),
    )
    const refused = await codeOf(
      adapter(closedPort).refund(`pi_ok_${randomUUID()}`, 500, 'requested_by_customer', {
        idempotencyKey: randomUUID(),
      }),
    )

    expect(apiError).toBe('payment.refund_unknown')
    expect(refused).toBe('payment.refund_unknown')
    expect(apiError).not.toBe('payment.refund_rejected')
  }, 20_000)
})
