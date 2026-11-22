import fc from 'fast-check'
import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import type { Logger, WebhookResult } from '@nymbalhq/types'
import { createStripePaymentsAdapter } from './index.js'

// The heartbeat's card charge is made on the store's own Stripe account, so Stripe sends its webhooks to the store. An
// intent (or a charge) whose metadata holds `nymbal_heartbeat` is the heartbeat's, never an order's: its webhooks are
// ignored. Every other event answers as before. Events are signed with Stripe's own scheme and the adapter's secret;
// nothing here talks to Stripe.

const SECRET_KEY = 'sk_test_heartbeat_webhooks'
const WEBHOOK_SECRET = 'whsec_heartbeat_webhooks'
const signer = new Stripe(SECRET_KEY)

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const adapter = createStripePaymentsAdapter({
  logger,
  config: { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET },
})

type Kind = 'payment_intent.succeeded' | 'payment_intent.payment_failed' | 'charge.refunded'
const KINDS: Kind[] = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
]

interface Shape {
  kind: Kind
  eventId: string
  intentId: string
  amount: number
  metadata: Record<string, string>
}

/** The event's object as Stripe sends it: an intent for the intent events, a charge for charge.refunded. */
function objectOf(s: Shape): Record<string, unknown> {
  if (s.kind === 'charge.refunded') {
    return {
      id: `ch_${s.intentId.slice(3)}`,
      object: 'charge',
      amount: s.amount,
      amount_refunded: s.amount,
      currency: 'gbp',
      payment_intent: s.intentId,
      refunded: true,
      metadata: s.metadata,
    }
  }
  return {
    id: s.intentId,
    object: 'payment_intent',
    amount: s.amount,
    amount_received: s.kind === 'payment_intent.succeeded' ? s.amount : 0,
    currency: 'gbp',
    status: s.kind === 'payment_intent.succeeded' ? 'succeeded' : 'requires_payment_method',
    metadata: s.metadata,
    ...(s.kind === 'payment_intent.payment_failed' && {
      last_payment_error: { message: 'Your card was declined.' },
    }),
  }
}

async function parse(s: Shape): Promise<WebhookResult> {
  const payload = JSON.stringify({
    id: s.eventId,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    type: s.kind,
    data: { object: objectOf(s) },
  })
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
  return adapter.parseWebhook(payload, signature)
}

/** What each kind answered before heartbeats existed. */
function asBefore(s: Shape): Partial<WebhookResult> {
  const base = { verified: true, eventId: s.eventId, paymentIntentId: s.intentId }
  if (s.kind === 'payment_intent.succeeded') {
    return { ...base, kind: 'payment.captured', amountMinor: s.amount, currency: 'GBP' }
  }
  if (s.kind === 'payment_intent.payment_failed') {
    return { ...base, kind: 'payment.failed', reason: 'Your card was declined.' }
  }
  return { ...base, kind: 'payment.refunded', amountMinor: s.amount, currency: 'GBP' }
}

const idArb = fc.stringMatching(/^[A-Za-z0-9]{8,16}$/)
/** Metadata an order's intent may carry: any keys but the heartbeat's. */
const otherMetadata = fc.dictionary(
  fc.stringMatching(/^[a-z_]{1,16}$/).filter((key) => key !== 'nymbal_heartbeat'),
  fc.string({ maxLength: 20 }),
  { maxKeys: 4 },
)
const shapeArb = fc.record({
  kind: fc.constantFrom(...KINDS),
  eventId: idArb.map((id) => `evt_${id}`),
  intentId: idArb.map((id) => `pi_${id}`),
  amount: fc.integer({ min: 1, max: 1_000_000 }),
  metadata: otherMetadata,
})

describe('AC-9: Stripe webhooks of the heartbeat’s card charge are ignored', () => {
  // Kills: every card-check charge reaching finalize as an order's payment, logging "captured payment not applied" and
  // publishing payment.failed each run.
  it('AC-9: a signed payment_intent.succeeded or payment_intent.payment_failed whose intent metadata holds nymbal_heartbeat, and a charge.refunded whose charge metadata holds it, answer ignored', async () => {
    for (const kind of KINDS) {
      const result = await parse({
        kind,
        eventId: `evt_heartbeat_${kind.replace(/\W/g, '_')}`,
        intentId: 'pi_heartbeat_card_check',
        amount: 100,
        metadata: { nymbal_heartbeat: 'card' },
      })
      expect({ kind, verified: result.verified, answer: result.kind }).toEqual({
        kind,
        verified: true,
        answer: 'ignored',
      })
    }
  })

  // Kills: a match on any metadata at all (every order's webhook ignored), or on a key other than nymbal_heartbeat.
  it('AC-9: property: over other metadata maps, the same events answer as before without the key, and ignored with it added', async () => {
    await fc.assert(
      fc.asyncProperty(shapeArb, fc.constantFrom('card', '1'), async (shape, value) => {
        expect(await parse(shape)).toMatchObject(asBefore(shape))
        const marked = await parse({
          ...shape,
          metadata: { ...shape.metadata, nymbal_heartbeat: value },
        })
        expect(marked.kind).toBe('ignored')
      }),
      { numRuns: 60 },
    )
  })
})
