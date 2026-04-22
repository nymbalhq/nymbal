import { EVT_PAYMENT_FAILED, type HttpAdapter, type PaymentsAdapter } from '@nymbal/types'
import type { CheckoutService } from '../services/checkout-service.js'
import type { EventPublisher } from '../events/publisher.js'
import type { DocumentStoreAdapter } from '@nymbal/types'
import { ok, fail, renderError } from './envelope.js'

const STRIPE_EVENT_LOG = 'stripe-webhook-log'

export interface RegisterStripeWebhookDeps {
  payments: PaymentsAdapter
  checkout: CheckoutService
  publisher: EventPublisher
  documentStore: DocumentStoreAdapter
}

export function registerStripeWebhookRoute(
  adapter: HttpAdapter,
  deps: RegisterStripeWebhookDeps,
): void {
  const { payments, checkout, publisher, documentStore } = deps

  adapter.registerRoute(
    'POST',
    '/api/webhooks/stripe',
    async (ctx) => {
      try {
        const rawSig = ctx.headers['stripe-signature']
        const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig
        if (!sig) return fail('webhook.signature_missing', 'stripe-signature header missing', 400)
        const raw = ctx.rawBody ?? Buffer.from(typeof ctx.body === 'string' ? ctx.body : JSON.stringify(ctx.body ?? {}))
        const result = await payments.parseWebhook(raw, sig)
        if (!result.verified) return fail('webhook.invalid', 'signature verification failed', 400)

        // Dedupe against cross-restart replay
        const existing = await documentStore.get<{ seen: true }>(STRIPE_EVENT_LOG, result.eventId)
        if (existing) return ok({ deduped: true })
        await documentStore.put(STRIPE_EVENT_LOG, result.eventId, { seen: true }, { ttl: 60 * 60 * 24 * 7 })

        if (result.kind === 'payment.captured' && result.paymentIntentId && result.amountMinor) {
          await checkout.finalize(result.paymentIntentId, result.amountMinor)
          return ok({ finalized: true })
        }
        if (result.kind === 'payment.failed' && result.paymentIntentId) {
          await publisher.publish(EVT_PAYMENT_FAILED, {
            paymentId: result.paymentIntentId,
            orderId: '',
            reason: result.reason ?? 'unknown',
          })
          return ok({ failed: true })
        }
        return ok({ ignored: true })
      } catch (err) {
        return renderError(err)
      }
    },
    { csrf: false, rawBody: true },
  )
}
