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
  refundedMinor: number
}

const STUB_ID_PREFIX = 'pi_stub_'

function rejected(message: string): PaymentError {
  return new PaymentError('refund_rejected', message)
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
 * no-op. Refunds follow a provider's rules for the intents this process holds (captured, and never beyond the
 * capture); an intent of its own lost to a restart is refunded as asked, the shop's refundable check being the guard.
 */
export function createNativeStubPaymentsAdapter(deps: { logger: Logger }): PaymentsAdapter {
  const { logger } = deps
  const intents = new Map<string, StubIntent>()
  return {
    kind: 'payments',
    providerName: 'native-stub',
    // No `webhook`: parseWebhook verifies no signature, so a template cannot rely on it.
    capabilities: () => ['intent', 'capture', 'refund'],
    producesEvents: [EVT_PAYMENT_CAPTURED, EVT_PAYMENT_FAILED, EVT_PAYMENT_REFUNDED],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth('stub — always healthy'),

    async createPaymentIntent(params: PaymentIntentParams): Promise<PaymentIntent> {
      const id = `${STUB_ID_PREFIX}${uuidv7()}`
      const intent: StubIntent = {
        id,
        amountMinor: params.amountMinor,
        currency: params.currency,
        status: statusFor(params.receiptEmail),
        refundedMinor: 0,
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

    async refund(paymentId, amountMinor, reason, opts): Promise<Refund> {
      if (!paymentId.startsWith(STUB_ID_PREFIX)) throw rejected(`${paymentId} is not a stub intent`)
      const answer = (amount: number, currency: string): Refund => ({
        refundId: `re_stub_${uuidv7()}`,
        paymentId,
        amountMinor: amount,
        currency,
        reason: reason ?? null,
        status: 'succeeded',
      })
      const intent = intents.get(paymentId)
      if (!intent) {
        if (amountMinor === undefined || amountMinor <= 0 || opts?.currency === undefined) {
          throw rejected(`intent ${paymentId} is no longer held: name the amount and currency`)
        }
        return answer(amountMinor, opts.currency)
      }
      if (intent.status !== 'succeeded') throw rejected(`intent ${paymentId} was never captured`)
      const left = intent.amountMinor - intent.refundedMinor
      const amount = amountMinor ?? left
      if (amount <= 0 || amount > left) {
        throw rejected(`refund of ${amount} exceeds the ${left} left on intent ${paymentId}`)
      }
      intent.refundedMinor += amount
      return answer(amount, intent.currency)
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
        // A stub webhook stands in for the shopper paying a waiting intent: the stub now holds it captured.
        const held =
          event.paymentIntentId === undefined ? undefined : intents.get(event.paymentIntentId)
        if (held !== undefined && event.kind === 'payment.captured') held.status = 'succeeded'
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
