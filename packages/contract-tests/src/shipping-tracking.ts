import { describe, expect, it } from 'vitest'
import {
  normaliseTrackingNumber,
  shippingTrackingProblem,
  shippingTrackingType,
  webhookDeliveryProblem,
  type CommerceAdapter,
  type ShippingTrackingStatus,
  type WebhookDelivery,
  type WebhookEventDraft,
} from '@nymbalhq/types'
import { CASE_MS, using, type Build } from './common.js'
import type { WebhookRequest } from './webhook.js'

/** One signed delivery as the provider sends it, and the tracking number its update is for. */
export interface ShippingTrackingSample {
  request: WebhookRequest
  trackingNumber: string
}

export interface ShippingTrackingContractOptions {
  /** A delivery of a delivered update. */
  delivered: () => ShippingTrackingSample
  /** A delivery of an in-transit update. Given, the suite checks it is classified `in_transit`. */
  inTransit?: () => ShippingTrackingSample
}

async function receive(
  adapter: CommerceAdapter,
  request: WebhookRequest,
): Promise<WebhookDelivery> {
  expect(typeof adapter.receiveWebhook, 'the adapter has no receiveWebhook').toBe('function')
  return adapter.receiveWebhook!(request.rawBody, request.headers)
}

/** The tracking events for `trackingNumber`, however either is spaced or cased, as the adapter hands them on. */
function eventsFor(
  delivery: WebhookDelivery,
  type: string,
  trackingNumber: string,
): WebhookEventDraft[] {
  const key = normaliseTrackingNumber(trackingNumber)
  return delivery.events.filter((e) => {
    const n = e.payload['trackingNumber']
    return e.type === type && typeof n === 'string' && normaliseTrackingNumber(n) === key
  })
}

/**
 * Certifies a shipping adapter's tracking updates from `receiveWebhook`: an update received twice is one delivery with
 * the same events, every delivery is one the kernel's route accepts for the shipping slot, and each update is
 * classified as the carrier reported it. Run it beside `runWebhookContract`.
 */
export function runShippingTrackingContract(
  name: string,
  build: Build<CommerceAdapter>,
  options: ShippingTrackingContractOptions,
): void {
  const samples = [options.delivered, options.inTransit].filter(
    (sample): sample is () => ShippingTrackingSample => sample !== undefined,
  )

  function classifies(
    sample: () => ShippingTrackingSample,
    status: ShippingTrackingStatus,
  ): () => Promise<void> {
    return () =>
      using(build, async (adapter) => {
        const { request, trackingNumber } = sample()
        const delivery = await receive(adapter, request)
        const updates = eventsFor(
          delivery,
          shippingTrackingType(adapter.providerName),
          trackingNumber,
        )
        expect(updates.length, `no tracking update for ${trackingNumber}`).toBeGreaterThan(0)
        expect(updates.map((e) => e.payload['status'])).toEqual(updates.map(() => status))
      })
  }

  describe(`shipping tracking contract: ${name}`, () => {
    // Kills: a delivery id minted per call, so each carrier retry of an update would be recorded and acted on again.
    it(
      'replay: one tracking update received twice gives one deliveryId and equal events',
      () =>
        using(build, async (adapter) => {
          const first = await receive(adapter, options.delivered().request)
          const second = await receive(adapter, options.delivered().request)
          expect(first.verified, 'the signed update was not verified').toBe(true)
          expect(typeof first.deliveryId === 'string' && first.deliveryId !== '').toBe(true)
          expect(second.deliveryId, 'the same update got another deliveryId').toBe(first.deliveryId)
          expect(second.events).toEqual(first.events)
        }),
      CASE_MS,
    )

    // Kills: an update with no tracking number, an unmapped status or an undeclared type: whatever the kernel's route
    // would answer 500 for on a live delivery to the shipping slot.
    it(
      "shape: every event passes the kernel's rules for this slot",
      () =>
        using(build, async (adapter) => {
          const tracking = shippingTrackingType(adapter.providerName)
          for (const sample of samples) {
            const delivery = await receive(adapter, sample().request)
            expect(delivery.verified, 'a signed delivery was not verified').toBe(true)
            expect(
              delivery.events.filter((e) => e.type === tracking).length,
              'the delivery carried no tracking update to check',
            ).toBeGreaterThan(0)
            expect(
              webhookDeliveryProblem(adapter.providerName, adapter.producesEvents, delivery),
              'the kernel would refuse this delivery',
            ).toBeNull()
            expect(
              shippingTrackingProblem(adapter.providerName, delivery),
              'the kernel would refuse this delivery for the shipping slot',
            ).toBeNull()
          }
        }),
      CASE_MS,
    )

    // Kills: a delivered parcel handed on under another status, which would never deliver the order.
    it(
      'classification: the delivered update is delivered for its tracking number',
      classifies(options.delivered, 'delivered'),
      CASE_MS,
    )

    if (options.inTransit !== undefined) {
      // Kills: a parcel still moving handed on as delivered, which would deliver the order early.
      it(
        'classification: the in-transit update is in transit for its tracking number',
        classifies(options.inTransit, 'in_transit'),
        CASE_MS,
      )
    }
  })
}
