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
} from '@nymbalhq/types'
import { noopInitialize, okHealth } from '../base.js'

interface StubIntent {
  id: string
  amountMinor: number
  currency: string
  status: PaymentStatus
  orderRef?: string
}

/**
 * Like Stripe's test cards, the receipt email's local part picks the outcome: ending `+stub-pending` the intent waits
 * for the shopper (a webhook pays it), ending `+stub-decline` it fails, and otherwise it is captured at creation.
 */
function statusFor(receiptEmail: string | undefined): PaymentStatus {
  const address = receiptEmail ?? ''
  const at = address.lastIndexOf('@')
  const local = at < 0 ? address : address.slice(0, at)
  if (local.endsWith('+stub-pending')) return 'requires_action'
  if (local.endsWith('+stub-decline')) return 'failed'
  return 'succeeded'
}

function toIntent(intent: StubIntent): PaymentIntent {
  return {
    id: intent.id,
    clientSecret: `${intent.id}_secret`,
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    status: intent.status,
  }
}

/**
 * Deterministic payments adapter for local development without Stripe keys.
 * Every intent succeeds at creation unless the receipt email asks otherwise (`statusFor`); webhook verification is a
 * no-op.
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
        status: statusFor(params.receiptEmail),
        ...(params.orderRef !== undefined && { orderRef: params.orderRef }),
      }
      intents.set(id, intent)
      logger.debug({ intentId: id, status: intent.status }, 'stub payment intent created')
      return toIntent(intent)
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

    async getPaymentIntent(intentId): Promise<PaymentIntent> {
      const intent = intents.get(intentId)
      if (!intent) throw new PaymentError('intent_failed', `unknown intent ${intentId}`)
      return toIntent(intent)
    },

    async cancelPaymentIntent(intentId): Promise<void> {
      // An intent this process never made (it restarted) cannot be paid through the stub: nothing to cancel.
      const intent = intents.get(intentId)
      if (!intent) return
      if (intent.status === 'succeeded') {
        throw new PaymentError('cancel_refused', `intent ${intentId} is already captured`)
      }
      intent.status = 'cancelled'
    },

    async parseWebhook(rawBody): Promise<WebhookResult> {
      try {
        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
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
