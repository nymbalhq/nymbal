import { randomUUID } from 'node:crypto'
import {
  PaymentError,
  type PaymentIntent,
  type PaymentStatus,
  type PaymentsAdapter,
  type Refund,
  type WebhookResult,
} from '@nymbalhq/types'

// An in-memory payments adapter that refunds like a provider (a captured intent, never past what is left) and replays a
// refund repeated under one idempotency key, and its defective twin: one that ignores the key, so a retry mints a new
// refund and moves the money again.

export interface PaymentsFlaws {
  ignoreIdempotencyKey?: boolean
}

interface Held {
  id: string
  amountMinor: number
  currency: string
  status: PaymentStatus
  refundedMinor: number
}

export function memoryPayments(flaws: PaymentsFlaws = {}): PaymentsAdapter {
  const intents = new Map<string, Held>()
  const answered = new Map<string, Refund>()
  const toIntent = (i: Held): PaymentIntent => ({
    id: i.id,
    clientSecret: `${i.id}_secret`,
    amountMinor: i.amountMinor,
    currency: i.currency,
    status: i.status,
  })
  return {
    kind: 'payments',
    providerName: 'contracts-memory-payments',
    capabilities: () => ['intent', 'capture', 'refund'],
    client: () => null,
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' }),

    async createPaymentIntent(params) {
      const intent: Held = {
        id: `pi_mem_${randomUUID()}`,
        amountMinor: params.amountMinor,
        currency: params.currency,
        status: 'succeeded',
        refundedMinor: 0,
      }
      intents.set(intent.id, intent)
      return toIntent(intent)
    },

    async capturePayment(intentId) {
      const intent = intents.get(intentId)
      if (intent === undefined) throw new PaymentError('capture_failed', `unknown ${intentId}`)
      intent.status = 'succeeded'
      return {
        paymentId: intent.id,
        capturedAmountMinor: intent.amountMinor,
        currency: intent.currency,
        status: 'succeeded',
      }
    },

    async refund(paymentId, amountMinor, reason, opts) {
      const key = flaws.ignoreIdempotencyKey === true ? undefined : opts?.idempotencyKey
      const replay = key === undefined ? undefined : answered.get(key)
      if (replay !== undefined) return replay
      const intent = intents.get(paymentId)
      if (intent === undefined || intent.status !== 'succeeded') {
        throw new PaymentError('refund_rejected', `${paymentId} holds no captured payment`)
      }
      const left = intent.amountMinor - intent.refundedMinor
      const amount = amountMinor ?? left
      if (amount <= 0 || amount > left) {
        throw new PaymentError('refund_rejected', `refund of ${amount} exceeds the ${left} left`)
      }
      intent.refundedMinor += amount
      const refund: Refund = {
        refundId: `re_mem_${randomUUID()}`,
        paymentId,
        amountMinor: amount,
        currency: intent.currency,
        reason: reason ?? null,
        status: 'succeeded',
      }
      if (key !== undefined) answered.set(key, refund)
      return refund
    },

    async getPaymentStatus(intentId) {
      return intents.get(intentId)?.status ?? 'failed'
    },

    async getPaymentIntent(intentId) {
      const intent = intents.get(intentId)
      if (intent === undefined) throw new PaymentError('intent_failed', `unknown ${intentId}`)
      return toIntent(intent)
    },

    async cancelPaymentIntent(intentId) {
      const intent = intents.get(intentId)
      if (intent !== undefined && intent.status !== 'succeeded') intent.status = 'cancelled'
    },

    async parseWebhook(rawBody): Promise<WebhookResult> {
      const event = JSON.parse(
        typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
      ) as {
        id?: string
      }
      return { verified: true, eventId: event.id ?? 'evt_mem', kind: 'ignored' }
    },
  }
}
