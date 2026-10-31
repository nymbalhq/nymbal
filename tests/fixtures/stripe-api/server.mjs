#!/usr/bin/env node
// An offline stand-in for Stripe's HTTP API, covering the calls the Stripe payments adapter makes and the one call
// Stripe.js makes for the shopper's card step. Request bodies are form-encoded (what stripe-node sends) and the fake
// honours the amount, currency and metadata it is sent: nothing a test asserts is hard-coded here.
//
// Refunds behave as Stripe's do, so the payments contract's idempotency case can see a double refund: a POST with an
// Idempotency-Key it has answered before gets that answer again and moves nothing; a refund needs a succeeded intent
// and never exceeds what is left of the amount received.
//
// The fake is the provider, so it delivers the webhook: `POST /v1/payment_intents/:id/confirm` (authorised by the
// secret key or by the intent's client_secret, as Stripe.js sends it) marks the intent succeeded, signs a
// `payment_intent.succeeded` for it with the webhook secret and posts it to the webhook URL before it answers.
//
//   node tests/fixtures/stripe-api/server.mjs --host <addr> --port <n> [--secret-key <sk>]
//                                             [--webhook-url <url> --webhook-secret <whsec>]
//
// prints the port it listens on and runs until SIGTERM or SIGINT. Imported, `startStripeFake(options)` does the same.

import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// stripe-node signs the webhook, so the signature is Stripe's own format; it resolves from the adapter's package.
const requireStripe = createRequire(
  new URL('../../../packages/adapters/payments/stripe/package.json', import.meta.url),
)
const StripeModule = requireStripe('stripe')
const Stripe = StripeModule.default ?? StripeModule

/** The header a delivered webhook carries its signature in. */
export const SIGNATURE_HEADER = 'stripe-signature'

const DEFAULT_SECRET_KEY = 'sk_test_mock'
const API_VERSION = '2025-02-24.acacia'

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function metadataFromParams(params) {
  const metadata = {}
  for (const [key, value] of params) {
    const match = /^metadata\[(.+)\]$/.exec(key)
    if (match) metadata[match[1]] = value
  }
  return metadata
}

/**
 * Starts the fake. `port` 0 takes a free one. With `webhookUrl` and `webhookSecret`, a confirm delivers the signed
 * event there; without them it only moves the intent.
 */
export async function startStripeFake(options = {}) {
  const host = options.host ?? '127.0.0.1'
  const secretKey = options.secretKey ?? DEFAULT_SECRET_KEY
  const { webhookUrl, webhookSecret } = options
  if ((webhookUrl === undefined) !== (webhookSecret === undefined)) {
    throw new Error('stripe-api fake: --webhook-url and --webhook-secret go together')
  }
  const signer = new Stripe(secretKey)

  const intents = new Map()
  /** What has been refunded of each intent, in minor units. */
  const refunded = new Map()
  /** Each Idempotency-Key's first answer, replayed to a retry as Stripe does. */
  const answered = new Map()
  /** The Idempotency-Key a response answers, when its request carried one. */
  const keyOf = new WeakMap()
  let seq = 0
  let eventSeq = 0

  function sendJson(res, statusCode, body) {
    const key = keyOf.get(res)
    if (key !== undefined) answered.set(key, { statusCode, body })
    res.writeHead(statusCode, {
      'content-type': 'application/json',
      'stripe-should-retry': 'false',
    })
    res.end(JSON.stringify(body))
  }

  function sendStripeError(res, statusCode, message, code) {
    sendJson(res, statusCode, {
      error: { type: 'invalid_request_error', message, ...(code !== undefined && { code }) },
    })
  }

  /** Posts a signed `payment_intent.succeeded` for `intent`; the store's answer, or the reason none came. */
  async function deliverSucceeded(intent) {
    eventSeq += 1
    const payload = JSON.stringify({
      id: `evt_fake_${eventSeq}_${intent.id}`,
      object: 'event',
      api_version: API_VERSION,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: 'payment_intent.succeeded',
      data: { object: { ...intent } },
    })
    const signature = signer.webhooks.generateTestHeaderString({ payload, secret: webhookSecret })
    try {
      const answer = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature },
        body: payload,
      })
      return { ok: answer.ok, status: answer.status, body: await answer.text() }
    } catch (error) {
      return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) }
    }
  }

  async function confirm(req, res, id, params) {
    const intent = intents.get(id)
    if (!intent) {
      sendStripeError(res, 404, `No such payment_intent: '${id}'`)
      return
    }
    const bySecretKey = req.headers.authorization === `Bearer ${secretKey}`
    if (!bySecretKey && params.get('client_secret') !== intent.client_secret) {
      sendJson(res, 401, { error: { type: 'invalid_request_error', message: 'Invalid API key' } })
      return
    }
    if (intent.status === 'succeeded') {
      sendStripeError(
        res,
        400,
        `This PaymentIntent (${intent.id}) has already succeeded.`,
        'payment_intent_unexpected_state',
      )
      return
    }
    intent.status = 'succeeded'
    intent.amount_received = intent.amount
    if (webhookUrl !== undefined) {
      const delivery = await deliverSucceeded(intent)
      if (!delivery.ok) {
        sendJson(res, 502, {
          error: {
            type: 'api_error',
            message: `webhook delivery to ${webhookUrl} answered ${delivery.status}: ${delivery.body.slice(0, 300)}`,
          },
        })
        return
      }
    }
    sendJson(res, 200, intent)
  }

  async function handleRequest(req, res) {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const method = req.method ?? 'GET'
    const body = await readBody(req)
    const params = new URLSearchParams(body)

    const confirmMatch = /^\/v1\/payment_intents\/([^/]+)\/confirm$/.exec(path)
    if (method === 'POST' && confirmMatch) {
      await confirm(req, res, confirmMatch[1], params)
      return
    }

    if (req.headers.authorization !== `Bearer ${secretKey}`) {
      sendJson(res, 401, { error: { type: 'invalid_request_error', message: 'Invalid API key' } })
      return
    }

    const header = req.headers['idempotency-key']
    const key = Array.isArray(header) ? header[0] : header
    const replay = method === 'POST' && key !== undefined ? answered.get(key) : undefined
    if (replay !== undefined) {
      sendJson(res, replay.statusCode, replay.body)
      return
    }
    if (method === 'POST' && key !== undefined) keyOf.set(res, key)

    if (method === 'POST' && path === '/v1/payment_intents') {
      const amountRaw = params.get('amount')
      const currency = params.get('currency')
      if (amountRaw === null || currency === null) {
        sendStripeError(res, 400, 'Missing required param: amount or currency')
        return
      }
      seq += 1
      const id = `pi_${seq}`
      const intent = {
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
      const intent = intents.get(captureMatch[1])
      if (!intent) {
        sendStripeError(res, 404, `No such payment_intent: '${captureMatch[1]}'`)
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
      const intent = intents.get(retrieveMatch[1])
      if (!intent) {
        sendStripeError(res, 404, `No such payment_intent: '${retrieveMatch[1]}'`)
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
      if (intent.status !== 'succeeded') {
        sendStripeError(
          res,
          400,
          `This PaymentIntent (${intent.id}) does not have a successful charge to refund.`,
          'payment_intent_unexpected_state',
        )
        return
      }
      const left = (intent.amount_received ?? 0) - (refunded.get(intent.id) ?? 0)
      const amountRaw = params.get('amount')
      const amount = amountRaw !== null ? Number(amountRaw) : left
      if (left <= 0) {
        sendStripeError(
          res,
          400,
          `Charge for ${intent.id} has already been refunded.`,
          'charge_already_refunded',
        )
        return
      }
      if (amount <= 0 || amount > left) {
        sendStripeError(
          res,
          400,
          `Refund amount (${amount}) is greater than unrefunded amount on charge (${left})`,
          'amount_too_large',
        )
        return
      }
      refunded.set(intent.id, (refunded.get(intent.id) ?? 0) + amount)
      seq += 1
      sendJson(res, 200, {
        id: `re_${seq}`,
        object: 'refund',
        amount,
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

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      process.stderr.write(
        `stripe-api fake: ${error instanceof Error ? error.stack : String(error)}\n`,
      )
      sendStripeError(res, 500, 'stripe-api fake error')
    })
  })
  server.listen(options.port ?? 0, host)
  await once(server, 'listening')
  const port = server.address().port
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return {
    port,
    url: `http://${urlHost}:${port}`,
    async close() {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

function runsAsScript() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (runsAsScript()) {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '0' },
      'secret-key': { type: 'string' },
      'webhook-url': { type: 'string' },
      'webhook-secret': { type: 'string' },
    },
  })
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`stripe-api fake: --port must be an integer from 0 to 65535\n`)
    process.exit(2)
  }
  const fake = await startStripeFake({
    host: values.host,
    port,
    ...(values['secret-key'] !== undefined && { secretKey: values['secret-key'] }),
    ...(values['webhook-url'] !== undefined && { webhookUrl: values['webhook-url'] }),
    ...(values['webhook-secret'] !== undefined && { webhookSecret: values['webhook-secret'] }),
  })
  process.stdout.write(`${fake.port}\n`)
  const stop = () => {
    fake.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
