import { describe, expect, it } from 'vitest'
import {
  webhookDeliveryProblem,
  type CommerceAdapter,
  type WebhookDelivery,
  type WebhookHeaders,
} from '@nymbalhq/types'
import { CASE_MS, using, type Build } from './common.js'

/** One delivery as the provider sends it: the exact bytes and the headers its signature is in. */
export interface WebhookRequest {
  rawBody: Buffer
  headers: WebhookHeaders
}

export interface WebhookContractOptions {
  /** One signed delivery carrying at least one event, as the provider would send it. */
  delivery: () => WebhookRequest
  /** The same delivery with one byte of its body changed. Given, the suite checks it is not verified. */
  tampered?: () => WebhookRequest
}

type Receiving = CommerceAdapter & Required<Pick<CommerceAdapter, 'receiveWebhook'>>

function receiving(adapter: CommerceAdapter): Receiving {
  expect(typeof adapter.receiveWebhook, 'the adapter has no receiveWebhook').toBe('function')
  return adapter as Receiving
}

async function receive(
  adapter: CommerceAdapter,
  request: WebhookRequest,
): Promise<WebhookDelivery> {
  return receiving(adapter).receiveWebhook(request.rawBody, request.headers)
}

/**
 * Certifies an adapter's `receiveWebhook`: one delivery received twice is one delivery, a tampered one is refused,
 * and every event it hands on is the adapter's own type with a plain JSON object payload.
 */
export function runWebhookContract(
  name: string,
  build: Build<CommerceAdapter>,
  options: WebhookContractOptions,
): void {
  describe(`webhook contract: ${name}`, () => {
    // Kills: a delivery id minted per call, so each provider retry is processed as a new delivery.
    it(
      'idempotency: one delivery received twice gives one deliveryId and equal events',
      () =>
        using(build, async (adapter) => {
          const first = await receive(adapter, options.delivery())
          const second = await receive(adapter, options.delivery())
          expect(first.verified, 'the signed delivery was not verified').toBe(true)
          expect(typeof first.deliveryId === 'string' && first.deliveryId !== '').toBe(true)
          expect(second.deliveryId, 'the same delivery got another deliveryId').toBe(
            first.deliveryId,
          )
          expect(second.events).toEqual(first.events)
        }),
      CASE_MS,
    )

    const tampered = options.tampered
    if (tampered !== undefined) {
      it(
        'verification: a tampered delivery is not verified',
        () =>
          using(build, async (adapter) => {
            const outcome = await receive(adapter, tampered()).then(
              (delivery) => ({ verified: delivery.verified, code: null }),
              (err: unknown) => ({
                verified: false,
                code: (err as { code?: unknown } | null)?.code,
              }),
            )
            expect(outcome.verified, 'a tampered delivery was verified').toBe(false)
            if (outcome.code !== null) expect(String(outcome.code)).toMatch(/webhook_invalid$/)
          }),
        CASE_MS,
      )
    }

    // Kills: an adapter that hands on a kernel event (payment.captured.v1), another adapter's, or a class-instance
    // payload: whatever the kernel's route would answer 500 for on a live delivery.
    it(
      "namespace: every event is the adapter's own, declared and versioned",
      () =>
        using(build, async (adapter) => {
          const delivery = await receive(adapter, options.delivery())
          expect(delivery.verified, 'the signed delivery was not verified').toBe(true)
          expect(delivery.events.length, 'the delivery carried no event to check').toBeGreaterThan(
            0,
          )
          expect(
            webhookDeliveryProblem(adapter.providerName, adapter.producesEvents, delivery),
            'the kernel would refuse this delivery',
          ).toBeNull()
        }),
      CASE_MS,
    )
  })
}
