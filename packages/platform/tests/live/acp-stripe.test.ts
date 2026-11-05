import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  acpClient,
  buyerEmail,
  createBody,
  fulfillmentDetails,
  seedPool,
  sptPayment,
  totalOf,
  withAcp,
  type AcpClient,
  type PoolVariant,
} from '../support/acp.js'
import { serveWithAgents, type AgentStore } from '../support/agents.js'
import { createKernel } from '../support/kernel.js'
import { committedStock } from '../support/mcp.js'

// AC-14, the live proof: an agentic checkout on real Stripe test mode. A Shared Payment Token minted by Stripe's own
// test helper pays a session through the Stripe adapter, and Stripe holds the PaymentIntent the order names as
// succeeded for the session's total; a token on a declining card leaves no order and no stock moved. Run only by
// scripts/stripe-live.sh, which finds the test keys and alone makes this project exist (NYMBAL_STRIPE_LIVE=1).

const SECRET = process.env['STRIPE_SECRET_KEY'] ?? ''
const PUBLISHABLE = process.env['STRIPE_PUBLISHABLE_KEY'] ?? ''
if (!SECRET.startsWith('sk_test_') || !PUBLISHABLE.startsWith('pk_test_')) {
  throw new Error(
    'only Stripe test keys run this proof (STRIPE_SECRET_KEY sk_test_…, STRIPE_PUBLISHABLE_KEY pk_test_…)',
  )
}

const STRIPE = 'https://api.stripe.com/v1'
const SPT_VERSION = '2026-10-28.preview'
const QUANTITY = 2

/** A call to Stripe's API as the test account; Stripe's own error message when it refuses, never a skip. */
async function stripe<T>(
  method: 'GET' | 'POST',
  path: string,
  form?: Record<string, string>,
  version?: string,
): Promise<T> {
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${SECRET}`,
      ...(form !== undefined && { 'content-type': 'application/x-www-form-urlencoded' }),
      ...(version !== undefined && { 'stripe-version': version }),
    },
    ...(form !== undefined && { body: new URLSearchParams(form).toString() }),
  })
  const body = (await res.json()) as T & { error?: { code?: string; message?: string } }
  if (!res.ok) {
    throw new Error(
      `Stripe ${method} ${path} answered ${res.status}: ${body.error?.code ?? ''} ${body.error?.message ?? ''}`,
    )
  }
  return body
}

/** A test SPT on `paymentMethod`, granted to this account for at most `maxAmount` cents for an hour. */
async function mintSpt(paymentMethod: string, maxAmount: number): Promise<string> {
  const token = await stripe<{ id: string; object: string }>(
    'POST',
    '/test_helpers/shared_payment/granted_tokens',
    {
      payment_method: paymentMethod,
      'usage_limits[currency]': 'usd',
      'usage_limits[max_amount]': String(maxAmount),
      'usage_limits[expires_at]': String(Math.floor(Date.now() / 1000) + 3600),
    },
    SPT_VERSION,
  )
  if (token.object !== 'shared_payment.granted_token')
    throw new Error(`Stripe minted a ${token.object}, not a shared payment granted token`)
  return token.id
}

/** USD, on the Stripe adapter with the test keys and a webhook secret no webhook is ever signed with. */
function onStripe(config: NymbalConfig): NymbalConfig {
  return withAcp({
    ...config,
    store: { ...config.store, currency: 'USD' },
    commerce: {
      ...config.commerce,
      payments: {
        provider: 'stripe',
        config: {
          secretKey: SECRET,
          publishableKey: PUBLISHABLE,
          webhookSecret: `whsec_${randomBytes(24).toString('hex')}`,
        },
      },
    },
  })
}

let store: AgentStore
let agent: AcpClient
let variant: PoolVariant
const startedAt = Date.now()

beforeAll(async () => {
  store = await serveWithAgents(await createKernel({ dialect: 'sqlite', configure: onStripe }))
  agent = acpClient(store.baseUrl)
  variant = (await seedPool(store, [{ priceMinor: 1_250, stock: 10 }]))[0]!
}, 120_000)

afterAll(async () => {
  await store?.stop()
})

/** create (lines only) → update (buyer and address) → ready_for_payment. */
async function readySession() {
  const created = await agent.create(
    createBody([{ variantId: variant.variantId, quantity: QUANTITY }], {
      email: null,
      fulfillment: false,
      currency: 'usd',
    }),
  )
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const updated = await agent.update(created.body.id, {
    buyer: { email: buyerEmail('live') },
    fulfillment_details: fulfillmentDetails(),
  })
  expect(updated.status, JSON.stringify(updated.body)).toBe(200)
  expect(updated.body.status).toBe('ready_for_payment')
  return updated.body
}

describe('AC-14: an agentic checkout paid with a Stripe test-mode Shared Payment Token', () => {
  // Kills: the delegated charge not reaching Stripe as Stripe expects (the wrong field, version or confirm); an order
  // confirmed on an intent Stripe does not hold as succeeded for the total; stock not committed.
  it('AC-14: a session for one variant at quantity 2 goes create → update → ready_for_payment; a test SPT on pm_card_visa completes it; the order is confirmed with captured = total; Stripe holds its PaymentIntent succeeded for the total in usd with metadata.orderId the order’s; stock fell by 2', async () => {
    const session = await readySession()
    const total = totalOf(session, 'total') ?? -1
    const stockBefore = committedStock(store.kernel.target, variant.variantId)
    const spt = await mintSpt('pm_card_visa', total)

    const done = await agent.complete(session.id, sptPayment(spt))
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    const order = await store.kernel.services.order.getById(done.body.order?.id ?? '')
    const intent = await stripe<{
      id: string
      status: string
      amount: number
      currency: string
      metadata: Record<string, string>
    }>('GET', `/payment_intents/${order.paymentIntentId ?? ''}`)

    expect(done.body.status).toBe('completed')
    expect(total).toBe(variant.priceMinor * QUANTITY)
    expect({ status: order.status, capturedMinor: order.capturedMinor }).toEqual({
      status: 'confirmed',
      capturedMinor: total,
    })
    expect({
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      orderId: intent.metadata['orderId'],
    }).toEqual({ status: 'succeeded', amount: total, currency: 'usd', orderId: order.id })
    expect(committedStock(store.kernel.target, variant.variantId)).toBe(stockBefore - QUANTITY)
    // The line scripts/stripe-live.sh prints: the PaymentIntent the proof made, and how long it took.
    process.stdout.write(
      `acp-stripe-live: ${intent.id} ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
    )
  })

  // Kills: a decline recorded as paid, or stock held by it.
  it('AC-14: a second session paid with a test SPT on pm_card_chargeDeclined answers payment_declined, stays ready_for_payment, and its stock is unchanged', async () => {
    const session = await readySession()
    const stockBefore = committedStock(store.kernel.target, variant.variantId)
    const spt = await mintSpt('pm_card_chargeDeclined', totalOf(session, 'total') ?? 0)

    const declined = await agent.complete(session.id, sptPayment(spt))

    expect(declined.status, JSON.stringify(declined.body)).toBe(200)
    expect(declined.body.status).toBe('ready_for_payment')
    expect(declined.body.messages.filter((m) => m.type === 'error').map((m) => m.code)).toEqual([
      'payment_declined',
    ])
    expect(committedStock(store.kernel.target, variant.variantId)).toBe(stockBefore)
  })
})
