import { v7 as uuidv7 } from 'uuid'
import {
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_FAILED,
  EVT_PAYMENT_REFUNDED,
  PaymentError,
  type Logger,
  type PaymentCapture,
  type PaymentIntent,
  type PaymentIntentParams,
  type PaymentStatus,
  type PaymentsAdapter,
  type Refund,
  type WebhookResult,
} from '@nymbal/types'
import { noopInitialize, okHealth } from '../base.js'

interface StubIntent {
  id: string
  amountMinor: number
  currency: string
  status: PaymentStatus
  orderRef?: string
}

/**
 * Deterministic payments adapter for local development without Stripe keys.
 * Every intent immediately succeeds; webhook verification is a no-op.
 */
export function createNativeStubPaymentsAdapter(deps: { logger: Logger }): PaymentsAdapter {
  const { logger } = deps
  const intents = new Map<string, StubIntent>()
  return {
    kind: 'payments',
    providerName: 'native-stub',
    capabilities: ['intent', 'capture', 'refund', 'webhook'],
    producesEvents: [EVT_PAYMENT_CAPTURED, EVT_PAYMENT_FAILED, EVT_PAYMENT_REFUNDED],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth('stub — always healthy'),

    async createPaymentIntent(params: PaymentIntentParams): Promise<PaymentIntent> {
      const id = `pi_stub_${uuidv7()}`
      const intent: StubIntent = {
        id,
        amountMinor: params.amountMinor,
        currency: params.currency,
        status: 'requires_confirmation',
        ...(params.orderRef !== undefined && { orderRef: params.orderRef }),
      }
      intents.set(id, intent)
      logger.debug({ intentId: id }, 'stub payment intent created')
      return {
        id,
        clientSecret: `${id}_secret`,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        status: intent.status,
      }
    },

    async capturePayment(intentId): Promise<PaymentCapture> {
      const intent = intents.get(intentId)
      if (!intent) throw new PaymentError('capture_failed', `unknown intent ${intentId}`)
      intent.status = 'succeeded'
      return {
        paymentId: intent.id,
        capturedAmountMinor: intent.amountMinor,
        currency: intent.currency,
        status: 'succeeded',
      }
    },

    async refund(paymentId, amountMinor, reason): Promise<Refund> {
      const intent = intents.get(paymentId)
      return {
        refundId: `re_stub_${uuidv7()}`,
        paymentId,
        amountMinor: amountMinor ?? intent?.amountMinor ?? 0,
        currency: intent?.currency ?? 'usd',
        reason: reason ?? null,
        status: 'succeeded',
      }
    },

    async getPaymentStatus(intentId) {
      return intents.get(intentId)?.status ?? 'failed'
    },

    async parseWebhook(rawBody): Promise<WebhookResult> {
      try {
        const body =
          typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
        const event = JSON.parse(body) as {
          id?: string
          kind?: WebhookResult['kind']
          paymentIntentId?: string
          amountMinor?: number
          currency?: string
        }
        return {
          verified: true,
          eventId: event.id ?? `evt_stub_${uuidv7()}`,
          kind: event.kind ?? 'ignored',
          ...(event.paymentIntentId !== undefined && { paymentIntentId: event.paymentIntentId }),
          ...(event.amountMinor !== undefined && { amountMinor: event.amountMinor }),
          ...(event.currency !== undefined && { currency: event.currency }),
        }
      } catch (err) {
        throw new PaymentError('webhook_invalid', 'stub webhook body not JSON', { cause: err })
      }
    },
  }
}
