import { describe, expect, it } from 'vitest'
import {
  emailFeedbackProblem,
  emailFeedbackType,
  webhookDeliveryProblem,
  type CommerceAdapter,
  type WebhookDelivery,
  type WebhookEventDraft,
} from '@nymbalhq/types'
import { CASE_MS, using, type Build } from './common.js'
import type { WebhookRequest } from './webhook.js'

/** One signed delivery as the provider sends it, and the address its bounce or complaint is for. */
export interface EmailFeedbackSample {
  request: WebhookRequest
  recipient: string
}

export interface EmailFeedbackContractOptions {
  /** A delivery of a hard bounce (the provider's permanent failure). */
  bounce: () => EmailFeedbackSample
  /** A delivery of a soft bounce (a transient failure). Given, the suite checks it is classified `soft`. */
  softBounce?: () => EmailFeedbackSample
  /** A delivery of a spam complaint. Given, the suite checks it is a complaint. */
  complaint?: () => EmailFeedbackSample
}

async function receive(
  adapter: CommerceAdapter,
  request: WebhookRequest,
): Promise<WebhookDelivery> {
  expect(typeof adapter.receiveWebhook, 'the adapter has no receiveWebhook').toBe('function')
  return adapter.receiveWebhook!(request.rawBody, request.headers)
}

/** The events of `type` for `recipient`, as the adapter hands them on. */
function eventsFor(
  delivery: WebhookDelivery,
  type: string,
  recipient: string,
): WebhookEventDraft[] {
  return delivery.events.filter((e) => e.type === type && e.payload['recipient'] === recipient)
}

/**
 * Certifies an email adapter's bounces and complaints from `receiveWebhook`: a bounce received twice is one delivery
 * with the same events, every delivery is one the kernel's route accepts for the email slot, and each bounce and
 * complaint is classified as the provider reported it. Run it beside `runWebhookContract`.
 */
export function runEmailFeedbackContract(
  name: string,
  build: Build<CommerceAdapter>,
  options: EmailFeedbackContractOptions,
): void {
  const samples = [options.bounce, options.softBounce, options.complaint].filter(
    (sample): sample is () => EmailFeedbackSample => sample !== undefined,
  )

  describe(`email feedback contract: ${name}`, () => {
    // Kills: a delivery id minted per call, so each provider retry of a bounce would be recorded again.
    it(
      'replay: one bounce received twice gives one deliveryId and equal events',
      () =>
        using(build, async (adapter) => {
          const first = await receive(adapter, options.bounce().request)
          const second = await receive(adapter, options.bounce().request)
          expect(first.verified, 'the signed bounce was not verified').toBe(true)
          expect(typeof first.deliveryId === 'string' && first.deliveryId !== '').toBe(true)
          expect(second.deliveryId, 'the same bounce got another deliveryId').toBe(first.deliveryId)
          expect(second.events).toEqual(first.events)
        }),
      CASE_MS,
    )

    // Kills: a bounce with no recipient, an unknown classification or an undeclared type: whatever the kernel's
    // route would answer 500 for on a live delivery to the email slot.
    it(
      "shape: every event passes the kernel's rules for this slot",
      () =>
        using(build, async (adapter) => {
          const feedback = [
            emailFeedbackType(adapter.providerName, 'bounced'),
            emailFeedbackType(adapter.providerName, 'complained'),
          ]
          for (const sample of samples) {
            const delivery = await receive(adapter, sample().request)
            expect(delivery.verified, 'a signed delivery was not verified').toBe(true)
            expect(
              delivery.events.filter((e) => feedback.includes(e.type)).length,
              'the delivery carried no bounce or complaint to check',
            ).toBeGreaterThan(0)
            expect(
              webhookDeliveryProblem(adapter.providerName, adapter.producesEvents, delivery),
              'the kernel would refuse this delivery',
            ).toBeNull()
            expect(
              emailFeedbackProblem(adapter.providerName, delivery),
              'the kernel would refuse this delivery for the email slot',
            ).toBeNull()
          }
        }),
      CASE_MS,
    )

    // Kills: a permanent failure handed on as soft, which would never suppress the address.
    it(
      'classification: the hard bounce is hard for its recipient',
      () =>
        using(build, async (adapter) => {
          const { request, recipient } = options.bounce()
          const delivery = await receive(adapter, request)
          const bounces = eventsFor(
            delivery,
            emailFeedbackType(adapter.providerName, 'bounced'),
            recipient,
          )
          expect(bounces.length, `no bounce for ${recipient}`).toBeGreaterThan(0)
          expect(bounces.map((e) => e.payload['bounce'])).toEqual(bounces.map(() => 'hard'))
        }),
      CASE_MS,
    )

    const { softBounce, complaint } = options
    if (softBounce !== undefined) {
      // Kills: a transient failure handed on as hard, which would stop mail to a mailbox that is only full.
      it(
        'classification: the soft bounce is soft for its recipient',
        () =>
          using(build, async (adapter) => {
            const { request, recipient } = softBounce()
            const delivery = await receive(adapter, request)
            const bounces = eventsFor(
              delivery,
              emailFeedbackType(adapter.providerName, 'bounced'),
              recipient,
            )
            expect(bounces.length, `no bounce for ${recipient}`).toBeGreaterThan(0)
            expect(bounces.map((e) => e.payload['bounce'])).toEqual(bounces.map(() => 'soft'))
          }),
        CASE_MS,
      )
    }

    if (complaint !== undefined) {
      it(
        'classification: the complaint is a complaint for its recipient',
        () =>
          using(build, async (adapter) => {
            const { request, recipient } = complaint()
            const delivery = await receive(adapter, request)
            const complaints = eventsFor(
              delivery,
              emailFeedbackType(adapter.providerName, 'complained'),
              recipient,
            )
            expect(complaints.length, `no complaint for ${recipient}`).toBeGreaterThan(0)
          }),
        CASE_MS,
      )
    }
  })
}
