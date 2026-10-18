import {
  EVT_PAYMENT_FAILED,
  PaymentError,
  type HttpAdapter,
  type PaymentsAdapter,
  type WebhookResult,
} from '@nymbalhq/types'
import type { CommandStore, Tx } from '../db/command-store.js'
import type { OrderRepository } from '../repositories/order.js'
import type { ProcessedEventRepository } from '../repositories/processed-event.js'
import type { CheckoutService } from '../services/checkout-service.js'
import type { EventPublisher } from '../events/publisher.js'
import { ok, fail, renderError } from './envelope.js'

/** The handler name of this route's processed-event records. */
const HANDLER = 'webhook:stripe'

export interface RegisterStripeWebhookDeps {
  payments: PaymentsAdapter
  checkout: CheckoutService
  publisher: EventPublisher
  store: CommandStore
  processedEvents: ProcessedEventRepository
  orders: OrderRepository
}

export function registerStripeWebhookRoute(
  adapter: HttpAdapter,
  deps: RegisterStripeWebhookDeps,
): void {
  const { payments, checkout, publisher, store, processedEvents, orders } = deps

  /** payment.failed for the intent, naming its order when there is one. */
  async function publishFailed(tx: Tx, paymentIntentId: string, reason: string): Promise<void> {
    const order = paymentIntentId ? await orders.findByPaymentIntentId(tx, paymentIntentId) : null
    await publisher.publish(EVT_PAYMENT_FAILED, {
      paymentId: paymentIntentId,
      orderId: order?.id ?? '',
      reason,
    })
  }

  async function handle(tx: Tx, result: WebhookResult) {
    if (result.kind === 'payment.captured') {
      const paymentIntentId = result.paymentIntentId ?? ''
      if (
        paymentIntentId === '' ||
        typeof result.amountMinor !== 'number' ||
        typeof result.currency !== 'string' ||
        result.currency === ''
      ) {
        await publishFailed(tx, paymentIntentId, 'malformed_capture')
        return ok({ finalized: false, reason: 'malformed_capture' })
      }
      const finalized = await checkout.finalize(paymentIntentId, {
        amountMinor: result.amountMinor,
        currency: result.currency,
      })
      return finalized.finalized
        ? ok({ finalized: true, orderNumber: finalized.orderNumber })
        : ok({ finalized: false, reason: finalized.reason })
    }
    if (result.kind === 'payment.failed' && result.paymentIntentId) {
      await publishFailed(tx, result.paymentIntentId, result.reason ?? 'unknown')
      return ok({ failed: true })
    }
    return ok({ ignored: true })
  }

  adapter.registerRoute(
    'POST',
    '/api/webhooks/stripe',
    async (ctx) => {
      try {
        const rawSig = ctx.headers['stripe-signature']
        const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig
        if (!sig) return fail('webhook.signature_missing', 'stripe-signature header missing', 400)
        // The signature covers the exact bytes sent; a body re-serialised from its parse would not verify.
        if (ctx.rawBody === undefined) {
          return fail('webhook.raw_body_missing', 'the HTTP adapter kept no raw request body', 500)
        }
        let result: WebhookResult
        try {
          result = await payments.parseWebhook(ctx.rawBody, sig)
        } catch (err) {
          if (err instanceof PaymentError && err.code === 'payment.webhook_invalid') {
            return fail('webhook.invalid', 'signature verification failed', 400)
          }
          throw err
        }
        if (!result.verified) return fail('webhook.invalid', 'signature verification failed', 400)

        // The record commits with the work or its recorded outcome, so a delivery whose work threw is run again.
        return await store.transaction(async (tx) => {
          if (await processedEvents.seen(tx, HANDLER, result.eventId)) return ok({ deduped: true })
          const answer = await handle(tx, result)
          await processedEvents.markProcessed(tx, HANDLER, result.eventId, new Date())
          return answer
        })
      } catch (err) {
        return renderError(err)
      }
    },
    { csrf: false, rawBody: true },
  )
}
