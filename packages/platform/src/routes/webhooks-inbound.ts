import {
  ConfigError,
  EVT_PAYMENT_FAILED,
  emailFeedbackProblem,
  shippingTrackingProblem,
  webhookDeliveryProblem,
  type CommerceAdapter,
  type CommerceSlot,
  type HttpAdapter,
  type PaymentsAdapter,
  type RequestContext,
  type ResponseEnvelope,
  type WebhookDelivery,
  type WebhookDeliveryProblem,
  type WebhookResult,
} from '@nymbalhq/types'
import { COMMERCE_SLOTS, type AdapterRegistry } from '../adapters/registry.js'
import type { CommandStore, Tx } from '../db/command-store.js'
import type { OrderRepository } from '../repositories/order.js'
import type { ProcessedEventRepository } from '../repositories/processed-event.js'
import type { CheckoutService } from '../services/checkout-service.js'
import { inOrderScope } from '../services/order-correlation.js'
import type { EventPublisher } from '../events/publisher.js'
import { runAsActor } from '../audit/actor.js'
import { audit } from '../audit/audit.js'
import { auditedRoute } from '../audit/idempotency.js'
import { ok, fail, renderError } from './envelope.js'

/** The name that always reaches the payments slot, whatever its provider: the URL Stripe dashboards already hold. */
const PAYMENTS_ALIAS = 'stripe'

type Hooked = CommerceAdapter & Required<Pick<CommerceAdapter, 'receiveWebhook'>>

type Target =
  | { kind: 'payments'; slot: 'payments'; adapter: PaymentsAdapter }
  | { kind: 'hooked'; slot: CommerceSlot; adapter: Hooked }

interface Targets {
  hooked: Map<string, Target>
  /** Names some slot's adapter has but takes no deliveries under, for the log only. */
  hookless: Map<string, CommerceSlot[]>
}

/**
 * `in`, not `typeof`: the not-configured adapter answers every property read with a throwing function, but has no
 * `has` trap, so it never counts as taking deliveries.
 */
export function isHooked(adapter: CommerceAdapter): adapter is Hooked {
  return 'receiveWebhook' in adapter && typeof adapter.receiveWebhook === 'function'
}

/**
 * What a slot's own consumers need of its deliveries, beyond the rule every adapter's events follow: a delivery
 * breaking it is refused before it is claimed, so the provider's retry after a fix is still received.
 */
const SLOT_WEBHOOK_RULES: Partial<
  Record<
    CommerceSlot,
    (providerName: string, delivery: WebhookDelivery) => WebhookDeliveryProblem | null
  >
> = {
  email: emailFeedbackProblem,
  shipping: shippingTrackingProblem,
}

/** Which slot each webhook name reaches. Two slots taking deliveries under one name stop startup. */
function webhookTargets(adapters: AdapterRegistry): Targets {
  const bySlot = new Map<string, Map<CommerceSlot, Target>>()
  const hookless = new Map<string, CommerceSlot[]>()
  const add = (name: string, target: Target) => {
    const slots = bySlot.get(name) ?? new Map<CommerceSlot, Target>()
    slots.set(target.slot, target)
    bySlot.set(name, slots)
  }
  const payments: Target = { kind: 'payments', slot: 'payments', adapter: adapters.payments }
  add(PAYMENTS_ALIAS, payments)
  add(adapters.payments.providerName, payments)
  for (const slot of COMMERCE_SLOTS) {
    const adapter: CommerceAdapter | null = adapters[slot]
    if (slot === 'payments' || adapter === null) continue
    if (isHooked(adapter)) add(adapter.providerName, { kind: 'hooked', slot, adapter })
    else hookless.set(adapter.providerName, [...(hookless.get(adapter.providerName) ?? []), slot])
  }
  const hooked = new Map<string, Target>()
  for (const [name, slots] of bySlot) {
    if (slots.size > 1) {
      const names = [...slots.keys()]
      throw new ConfigError(
        `webhook provider '${name}' is taken by more than one slot that receives webhooks: ${names.join(' and ')}`,
        { code: 'config.webhook_provider_ambiguous', context: { name, slots: names } },
      )
    }
    hooked.set(name, [...slots.values()][0]!)
  }
  return { hooked, hookless }
}

function isWebhookInvalid(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.endsWith('webhook_invalid')
}

const invalid = () => fail('webhook.invalid', 'signature verification failed', 400)
const notFound = () => fail('webhook.not_found', 'no webhook is received under this name', 404)
const noRawBody = () =>
  fail('webhook.raw_body_missing', 'the HTTP adapter kept no raw request body', 500)

export interface RegisterInboundWebhookDeps {
  adapters: AdapterRegistry
  checkout: CheckoutService
  publisher: EventPublisher
  store: CommandStore
  processedEvents: ProcessedEventRepository
  orders: OrderRepository
}

export function registerInboundWebhookRoute(
  adapter: HttpAdapter,
  deps: RegisterInboundWebhookDeps,
): void {
  const { checkout, publisher, store, processedEvents, orders } = deps
  const targets = webhookTargets(deps.adapters)

  /** payment.failed for the intent, naming its order, and under its checkout's id, when there is one. */
  async function publishFailed(tx: Tx, paymentIntentId: string, reason: string): Promise<void> {
    const order = paymentIntentId ? await orders.findByPaymentIntentId(tx, paymentIntentId) : null
    await inOrderScope(order, () =>
      publisher.publish(EVT_PAYMENT_FAILED, {
        paymentId: paymentIntentId,
        orderId: order?.id ?? '',
        reason,
      }),
    )
  }

  async function handlePayment(tx: Tx, result: WebhookResult) {
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

  // The record is claimed before the work, in the work's transaction: a concurrent duplicate waits on its key and
  // finds it taken, and a delivery whose work throws rolls its claim back, so the provider's retry runs it again.

  async function receivePayment(
    ctx: RequestContext,
    name: string,
    payments: PaymentsAdapter,
  ): Promise<ResponseEnvelope> {
    const rawSig = ctx.headers['stripe-signature']
    const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig
    if (!sig) return fail('webhook.signature_missing', 'stripe-signature header missing', 400)
    // The signature covers the exact bytes sent; a body re-serialised from its parse would not verify.
    if (ctx.rawBody === undefined) return noRawBody()
    let result: WebhookResult
    try {
      result = await payments.parseWebhook(ctx.rawBody, sig)
    } catch (err) {
      if (isWebhookInvalid(err)) return invalid()
      throw err
    }
    if (!result.verified) return invalid()
    return store.transaction(async (tx) => {
      if (!(await processedEvents.claim(tx, `webhook:${name}`, result.eventId, new Date()))) {
        return ok({ deduped: true })
      }
      return handlePayment(tx, result)
    })
  }

  async function receiveHooked(
    ctx: RequestContext,
    name: string,
    target: Extract<Target, { kind: 'hooked' }>,
  ): Promise<ResponseEnvelope> {
    if (ctx.rawBody === undefined) return noRawBody()
    let delivery: WebhookDelivery
    try {
      delivery = await target.adapter.receiveWebhook(ctx.rawBody, ctx.headers)
    } catch (err) {
      if (isWebhookInvalid(err)) return invalid()
      throw err
    }
    if (!delivery.verified) return invalid()
    const problem =
      webhookDeliveryProblem(
        target.adapter.providerName,
        target.adapter.producesEvents,
        delivery,
      ) ??
      SLOT_WEBHOOK_RULES[target.slot]?.(target.adapter.providerName, delivery) ??
      null
    if (problem !== null) {
      // The provider retries this for its whole window, so the log is the store owner's only signal.
      ctx.logger.warn(
        { webhook: name, slot: target.slot, type: problem.type, reason: problem.reason },
        'a webhook delivery was refused: its events break the adapter event rule',
      )
      return fail(
        'webhook.event_invalid',
        `the delivery's events are refused: ${problem.reason}`,
        500,
      )
    }
    const handler = `webhook:${name}`
    return store.transaction(async (tx) => {
      if (!(await processedEvents.claim(tx, handler, delivery.deliveryId, new Date()))) {
        return ok({ deduped: true })
      }
      audit.note('webhook.receive', [{ type: 'webhook', id: `${name}:${delivery.deliveryId}` }])
      await publisher.publishUntyped(
        delivery.events.map(({ type, payload }) => ({ type, payload })),
        { source: handler },
      )
      return ok({ received: true, events: delivery.events.length })
    })
  }

  adapter.registerRoute(
    'POST',
    '/api/webhooks/:adapter',
    async (ctx) => {
      const name = ctx.params['adapter'] ?? ''
      const target = targets.hooked.get(name)
      if (target === undefined) {
        const slots = targets.hookless.get(name)
        ctx.logger.warn(
          { webhook: name, ...(slots !== undefined && { slots }) },
          slots === undefined
            ? 'a webhook delivery named no provider of this store'
            : 'a webhook delivery named a provider whose adapter takes no webhooks',
        )
        return notFound()
      }
      // The provider's deliveries act as the system, not as the anonymous caller the request's principal says.
      return runAsActor({ kind: 'system', id: `${name}-webhook` }, () =>
        auditedRoute(
          store,
          target.kind === 'payments' ? 'payment.finalize' : 'webhook.receive',
          async () => {
            try {
              return target.kind === 'payments'
                ? await receivePayment(ctx, name, target.adapter)
                : await receiveHooked(ctx, name, target)
            } catch (err) {
              return renderError(err)
            }
          },
        ),
      )
    },
    { csrf: false, rawBody: true },
  )
}
