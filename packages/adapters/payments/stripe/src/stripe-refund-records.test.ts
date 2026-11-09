import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PaymentError, type Logger, type PaymentsAdapter, type Refund } from '@nymbalhq/types'
import { createStripePaymentsAdapter } from './index.js'

// The adapter against the real stripe-node client, over a local HTTP stand-in for Stripe's refunds endpoints, so what
// is asserted is what crossed the wire and what came back, whichever way the adapter pages.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const SECRET_KEY = 'sk_test_records'
const WEBHOOK_SECRET = 'whsec_test_records'

interface StripeRefund {
  id: string
  object: 'refund'
  amount: number
  currency: string
  payment_intent: string
  reason: string | null
  status: string
  metadata: Record<string, string> | null
}

interface ListedRefund extends Refund {
  idempotencyKey: string | null
}

let served: StripeRefund[] = []
let pageCap = 100
let failList = false
let lastPost: { params: URLSearchParams; idempotencyKey: string | undefined } | undefined
let server: Server
let port = 0

function send(res: ServerResponse, status: number, body: unknown, retry = false): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(retry ? {} : { 'stripe-should-retry': 'false' }),
  })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function handleList(url: URL, res: ServerResponse): void {
  if (failList) {
    send(res, 500, { error: { type: 'api_error', message: 'list is down' } })
    return
  }
  const intent = url.searchParams.get('payment_intent')
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '10'), pageCap)
  const after = url.searchParams.get('starting_after')
  const held = served.filter((r) => r.payment_intent === intent)
  const start = after === null ? 0 : held.findIndex((r) => r.id === after) + 1
  const page = held.slice(start, start + limit)
  send(res, 200, {
    object: 'list',
    url: '/v1/refunds',
    has_more: start + limit < held.length,
    data: page,
  })
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const body = await readBody(req)
  if (req.method === 'POST' && url.pathname === '/v1/refunds') {
    const params = new URLSearchParams(body)
    const key = req.headers['idempotency-key']
    lastPost = { params, idempotencyKey: Array.isArray(key) ? key[0] : key }
    send(res, 200, {
      id: 're_posted',
      object: 'refund',
      amount: Number(params.get('amount') ?? '0'),
      currency: 'gbp',
      payment_intent: params.get('payment_intent'),
      reason: null,
      status: 'succeeded',
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/v1/refunds') {
    handleList(url, res)
    return
  }
  send(res, 404, { error: { type: 'invalid_request_error', message: 'unrecognized' } })
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void handle(req, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.close()
  await once(server, 'close')
})

function adapter(): PaymentsAdapter {
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

/** The refunds a list call answered, or an empty list while the adapter has no such call. */
async function listRefunds(paymentId: string): Promise<ListedRefund[]> {
  const a = adapter() as unknown as {
    listRefunds?: (id: string) => Promise<ListedRefund[]>
  }
  return (await a.listRefunds?.(paymentId)) ?? []
}

const KEY = 'nymbal_refund_key'

describe('refund records at Stripe', () => {
  // Defect: the key never reaches the provider's record, so no row can be matched later.
  it('AC-1: refund with a key sends metadata.nymbal_refund_key equal to it and to the idempotency option; with no key there is no metadata field', async () => {
    const key = 'row-id-1'
    await adapter().refund('pi_keyed', 500, 'requested_by_customer', { idempotencyKey: key })
    expect(lastPost?.params.get(`metadata[${KEY}]`)).toBe(key)
    expect(lastPost?.params.get(`metadata[${KEY}]`)).toBe(lastPost?.idempotencyKey)

    await adapter().refund('pi_plain', 500, 'requested_by_customer')
    expect([...(lastPost?.params.keys() ?? [])].filter((p) => p.startsWith('metadata'))).toEqual([])
  })

  const generatedRefund = fc.record({
    amount: fc.integer({ min: 1, max: 100_000 }),
    currency: fc.constantFrom('gbp', 'usd', 'eur'),
    reason: fc.constantFrom(null, 'duplicate', 'requested_by_customer', 'fraudulent'),
    status: fc.constantFrom('succeeded', 'failed', 'canceled', 'pending', 'requires_action'),
    key: fc.option(fc.uuid(), { nil: null }),
    foreign: fc.boolean(),
    otherMetadata: fc.boolean(),
  })

  const PAGE_SIZE_CAPS = fc.integer({ min: 1, max: 7 })

  // Defect: a second page is dropped, an unkeyed refund reads a key, or a status or another intent's refund leaks in.
  it('AC-2: property: listRefunds returns every refund of the intent across pages, with its id, amount, ISO uppercase currency, reason, status by refundStatus and the key from the metadata or null', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(generatedRefund, { minLength: 1, maxLength: 230 }),
        PAGE_SIZE_CAPS,
        async (generated, cap) => {
          pageCap = cap
          const intent = 'pi_records'
          served = generated.map((g, i) => ({
            id: `re_${i}`,
            object: 'refund',
            amount: g.amount,
            currency: g.currency,
            payment_intent: g.foreign ? 'pi_other' : intent,
            reason: g.reason,
            status: g.status,
            metadata:
              g.key !== null ? { [KEY]: g.key } : g.otherMetadata ? { source: 'dashboard' } : null,
          }))
          const held = generated
            .map((g, i) => ({ g, i }))
            .filter(({ g }) => !g.foreign)
            .map(
              ({ g, i }): ListedRefund => ({
                refundId: `re_${i}`,
                paymentId: intent,
                amountMinor: g.amount,
                currency: g.currency.toUpperCase(),
                reason: g.reason,
                status:
                  g.status === 'succeeded'
                    ? 'succeeded'
                    : g.status === 'failed' || g.status === 'canceled'
                      ? 'failed'
                      : 'pending',
                idempotencyKey: g.key,
              }),
            )
          fc.pre(held.length > 0)
          const byId = (a: ListedRefund, b: ListedRefund) => a.refundId.localeCompare(b.refundId)

          const list = await listRefunds(intent)

          expect([...list].sort(byId)).toEqual([...held].sort(byId))
        },
      ),
      { numRuns: 15, endOnFailure: true },
    )
  }, 120_000)

  // Defect: a lookup failure escapes untyped, so the caller cannot tell it from a bad answer.
  it('AC-2: a list call that throws becomes PaymentError refund_lookup_failed', async () => {
    failList = true
    try {
      const a = adapter() as unknown as { listRefunds?: (id: string) => Promise<unknown> }
      const thrown = await Promise.resolve(a.listRefunds?.('pi_down')).then(
        () => null,
        (err: unknown) => err,
      )
      expect((thrown as PaymentError | null)?.code).toBe('payment.refund_lookup_failed')
      expect(thrown).toBeInstanceOf(PaymentError)
    } finally {
      failList = false
    }
  })
})
