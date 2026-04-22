import Stripe from 'stripe'
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

export interface StripePaymentsConfig {
  secretKey: string
  webhookSecret: string
  apiVersion?: string
}

function mapStatus(status: Stripe.PaymentIntent.Status): PaymentStatus {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
    case 'requires_capture':
    case 'succeeded':
    case 'canceled':
      return status === 'canceled' ? 'cancelled' : (status as PaymentStatus)
    default:
      return 'failed'
  }
}

export function createStripePaymentsAdapter(deps: {
  logger: Logger
  config: StripePaymentsConfig
}): PaymentsAdapter {
  const { logger } = deps
  const cfg = deps.config
  if (!cfg.secretKey) throw new PaymentError('not_configured', 'Stripe secretKey missing')
  if (!cfg.webhookSecret) throw new PaymentError('not_configured', 'Stripe webhookSecret missing')
  const stripeClient = new Stripe(cfg.secretKey, {
    ...(cfg.apiVersion !== undefined && {
      apiVersion: cfg.apiVersion as Stripe.LatestApiVersion,
    }),
  })
  return {
    kind: 'payments',
    providerName: 'stripe',
    capabilities: ['intent', 'capture', 'refund', 'webhook'],
    producesEvents: [EVT_PAYMENT_CAPTURED, EVT_PAYMENT_FAILED, EVT_PAYMENT_REFUNDED],
    consumesEvents: [],
    async initialize() {
      // no-op: Stripe client already constructed
    },
    async healthCheck() {
      try {
        await stripeClient.balance.retrieve()
        return { status: 'healthy' }
      } catch (err) {
        return {
          status: 'down',
          detail: err instanceof Error ? err.message : String(err),
        }
      }
    },
    async createPaymentIntent(params: PaymentIntentParams): Promise<PaymentIntent> {
      try {
        const intent = await stripeClient.paymentIntents.create({
          amount: params.amountMinor,
          currency: params.currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          metadata: {
            ...(params.metadata ?? {}),
            ...(params.orderRef !== undefined ? { orderRef: params.orderRef } : {}),
            ...(params.customerId !== undefined ? { customerId: params.customerId } : {}),
          },
        })
        return {
          id: intent.id,
          clientSecret: intent.client_secret ?? '',
          amountMinor: intent.amount,
          currency: intent.currency,
          status: mapStatus(intent.status),
        }
      } catch (err) {
        throw new PaymentError('intent_failed', 'Stripe createPaymentIntent failed', { cause: err })
      }
    },
    async capturePayment(intentId, amountMinor): Promise<PaymentCapture> {
      try {
        const captured = await stripeClient.paymentIntents.capture(intentId, {
          ...(amountMinor !== undefined && { amount_to_capture: amountMinor }),
        })
        return {
          paymentId: captured.id,
          capturedAmountMinor: captured.amount_received ?? captured.amount,
          currency: captured.currency,
          status: mapStatus(captured.status),
        }
      } catch (err) {
        throw new PaymentError('capture_failed', 'Stripe capturePayment failed', { cause: err })
      }
    },
    async refund(paymentId, amountMinor, reason): Promise<Refund> {
      try {
        const refund = await stripeClient.refunds.create({
          payment_intent: paymentId,
          ...(amountMinor !== undefined && { amount: amountMinor }),
          ...(reason !== undefined && { reason: reason as Stripe.RefundCreateParams.Reason }),
        })
        return {
          refundId: refund.id,
          paymentId,
          amountMinor: refund.amount,
          currency: refund.currency,
          reason: refund.reason ?? null,
          status: (refund.status ?? 'pending') as Refund['status'],
        }
      } catch (err) {
        throw new PaymentError('refund_failed', 'Stripe refund failed', { cause: err })
      }
    },
    async getPaymentStatus(intentId): Promise<PaymentStatus> {
      const intent = await stripeClient.paymentIntents.retrieve(intentId)
      return mapStatus(intent.status)
    },
    async parseWebhook(rawBody, signature): Promise<WebhookResult> {
      let event: Stripe.Event
      try {
        event = stripeClient.webhooks.constructEvent(rawBody, signature, cfg.webhookSecret)
      } catch (err) {
        throw new PaymentError('webhook_invalid', 'Stripe webhook signature invalid', { cause: err })
      }
      const baseResult = { verified: true, eventId: event.id } as const
      switch (event.type) {
        case 'payment_intent.succeeded': {
          const intent = event.data.object as Stripe.PaymentIntent
          return {
            ...baseResult,
            kind: 'payment.captured',
            paymentIntentId: intent.id,
            amountMinor: intent.amount_received ?? intent.amount,
            currency: intent.currency,
            raw: { ...intent } as unknown as Record<string, unknown>,
          }
        }
        case 'payment_intent.payment_failed': {
          const intent = event.data.object as Stripe.PaymentIntent
          return {
            ...baseResult,
            kind: 'payment.failed',
            paymentIntentId: intent.id,
            reason: intent.last_payment_error?.message ?? 'payment failed',
          }
        }
        case 'charge.refunded': {
          const charge = event.data.object as Stripe.Charge
          const pi =
            typeof charge.payment_intent === 'string'
              ? charge.payment_intent
              : charge.payment_intent?.id
          return {
            ...baseResult,
            kind: 'payment.refunded',
            ...(pi !== undefined && { paymentIntentId: pi }),
            amountMinor: charge.amount_refunded,
            currency: charge.currency,
          }
        }
        default:
          logger.debug({ type: event.type }, 'stripe webhook ignored')
          return { ...baseResult, kind: 'ignored' }
      }
    },
  }
}
