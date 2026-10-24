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
} from '@nymbalhq/types'

export interface StripePaymentsConfig {
  secretKey: string
  webhookSecret: string
  /** The public key the storefront's Stripe.js uses; served by GET /api/capabilities. */
  publishableKey?: string
  apiVersion?: string
  /** Override the Stripe API host (for stripe-mock style test servers). Omit in production. */
  host?: string
  /** Override the Stripe API port. Only used together with `host`. */
  port?: number
  /** Override the Stripe API protocol. Defaults to https when omitted. */
  protocol?: 'http' | 'https'
}

/**
 * Stripe returns lowercase ISO currency codes (e.g. "gbp"); Nymbal's canonical
 * currency format is uppercase ISO 4217 (e.g. "GBP") everywhere else in the
 * domain, so adapter results are normalised on the way out.
 */
function toIsoCurrency(currency: string): string {
  return currency.toUpperCase()
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

function refundStatus(status: string | null): Refund['status'] {
  if (status === 'succeeded') return 'succeeded'
  if (status === 'failed' || status === 'canceled') return 'failed'
  return 'pending'
}

/**
 * Stripe refused the refund outright (a card error, an invalid request): no money moved. Anything else (an API error,
 * a timeout, a dropped connection) leaves the outcome unknown.
 */
function isDefiniteRefusal(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type
  return type === 'StripeCardError' || type === 'StripeInvalidRequestError'
}

function toIntent(intent: Stripe.PaymentIntent): PaymentIntent {
  return {
    id: intent.id,
    clientSecret: intent.client_secret ?? '',
    amountMinor: intent.amount,
    currency: toIsoCurrency(intent.currency),
    status: mapStatus(intent.status),
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
  // The publishable key is served to every shopper: a secret or restricted key pasted there must never be.
  if (cfg.publishableKey !== undefined && /^(sk|rk)_/.test(cfg.publishableKey)) {
    throw new PaymentError(
      'not_configured',
      'Stripe publishableKey holds a secret key; use the pk_ key',
    )
  }
  const stripeClient = new Stripe(cfg.secretKey, {
    ...(cfg.apiVersion !== undefined && {
      apiVersion: cfg.apiVersion as Stripe.LatestApiVersion,
    }),
    ...(cfg.host !== undefined && { host: cfg.host }),
    ...(cfg.port !== undefined && { port: cfg.port }),
    ...(cfg.protocol !== undefined && { protocol: cfg.protocol }),
  })
  return {
    kind: 'payments',
    providerName: 'stripe',
    capabilities: () => ['intent', 'capture', 'refund', 'webhook'],
    // Without a key the storefront's stripe driver reports it cannot mount, which keeps Place Order disabled.
    client: () => ({
      driver: 'stripe',
      options: cfg.publishableKey ? { publishableKey: cfg.publishableKey } : {},
    }),
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
          ...(params.receiptEmail !== undefined && { receipt_email: params.receiptEmail }),
          metadata: {
            ...(params.metadata ?? {}),
            ...(params.orderRef !== undefined ? { orderRef: params.orderRef } : {}),
            ...(params.customerId !== undefined ? { customerId: params.customerId } : {}),
          },
        })
        return toIntent(intent)
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
          currency: toIsoCurrency(captured.currency),
          status: mapStatus(captured.status),
        }
      } catch (err) {
        throw new PaymentError('capture_failed', 'Stripe capturePayment failed', { cause: err })
      }
    },
    async refund(paymentId, amountMinor, reason, opts): Promise<Refund> {
      const params: Stripe.RefundCreateParams = {
        payment_intent: paymentId,
        ...(amountMinor !== undefined && { amount: amountMinor }),
        ...(reason !== undefined && { reason: reason as Stripe.RefundCreateParams.Reason }),
      }
      try {
        const refund =
          opts?.idempotencyKey === undefined
            ? await stripeClient.refunds.create(params)
            : await stripeClient.refunds.create(params, { idempotencyKey: opts.idempotencyKey })
        return {
          refundId: refund.id,
          paymentId,
          amountMinor: refund.amount,
          currency: toIsoCurrency(refund.currency),
          reason: refund.reason ?? null,
          status: refundStatus(refund.status),
        }
      } catch (err) {
        if (isDefiniteRefusal(err)) {
          throw new PaymentError('refund_rejected', 'Stripe refused the refund', { cause: err })
        }
        throw new PaymentError('refund_unknown', 'Stripe refund outcome unknown', { cause: err })
      }
    },
    async getPaymentStatus(intentId): Promise<PaymentStatus> {
      const intent = await stripeClient.paymentIntents.retrieve(intentId)
      return mapStatus(intent.status)
    },
    async getPaymentIntent(intentId): Promise<PaymentIntent> {
      try {
        return toIntent(await stripeClient.paymentIntents.retrieve(intentId))
      } catch (err) {
        throw new PaymentError('intent_failed', 'Stripe getPaymentIntent failed', { cause: err })
      }
    },
    async cancelPaymentIntent(intentId): Promise<void> {
      try {
        await stripeClient.paymentIntents.cancel(intentId)
      } catch (err) {
        // A cancel that lost a race with an earlier one of ours is done; anything else (processing, captured) stays.
        const status = await stripeClient.paymentIntents
          .retrieve(intentId)
          .then((intent) => intent.status)
          .catch(() => undefined)
        if (status === 'canceled') return
        throw new PaymentError('cancel_refused', `Stripe would not cancel ${intentId}`, {
          cause: err,
        })
      }
    },
    async parseWebhook(rawBody, signature): Promise<WebhookResult> {
      let event: Stripe.Event
      try {
        event = stripeClient.webhooks.constructEvent(rawBody, signature, cfg.webhookSecret)
      } catch (err) {
        throw new PaymentError('webhook_invalid', 'Stripe webhook signature invalid', {
          cause: err,
        })
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
            currency: toIsoCurrency(intent.currency),
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
            currency: toIsoCurrency(charge.currency),
          }
        }
        default:
          logger.debug({ type: event.type }, 'stripe webhook ignored')
          return { ...baseResult, kind: 'ignored' }
      }
    },
  }
}
