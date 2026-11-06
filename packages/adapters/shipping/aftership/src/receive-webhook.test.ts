import { createHmac } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ShippingAdapter, WebhookDelivery } from '@nymbalhq/types'
import {
  AFTERSHIP_SIGNATURE_HEADER,
  AFTERSHIP_TAGS,
  AFTERSHIP_TEST_WEBHOOK_SECRET,
  aftershipRequest,
  aftershipTime,
  changeOneByte,
  signAfterShip,
  signedPost,
  trackingUpdate,
  webhookBody,
  type AfterShipRequest,
} from '../../../../../tests/support/aftership'
import { createAfterShipShippingAdapter } from './index.js'
import { silent } from './tests/support.js'

// AfterShip's tracking webhooks: only a post whose `aftership-hmac-sha256` is the base64 HMAC-SHA256 of its exact bytes
// under the store's secret (as UTF-8) verifies, under its event_id; a tracking_update becomes one aftership.tracking.v1
// whose status follows the tag table (only Delivered delivers), and any other event is verified with no events, so it
// is answered 200 and not retried.

const adapter = (webhookSecret?: string): ShippingAdapter =>
  createAfterShipShippingAdapter({
    logger: silent,
    config: webhookSecret === undefined ? {} : { webhookSecret },
  })

const receive = (a: ShippingAdapter, r: AfterShipRequest): Promise<WebhookDelivery> =>
  a.receiveWebhook!(r.rawBody, r.headers)

/** AfterShip's tags onto the kernel's tracking statuses: only Delivered delivers. */
const STATUS: Record<string, string> = {
  Pending: 'pre_transit',
  InfoReceived: 'pre_transit',
  InTransit: 'in_transit',
  OutForDelivery: 'out_for_delivery',
  AvailableForPickup: 'out_for_delivery',
  Delivered: 'delivered',
  AttemptFail: 'exception',
  Exception: 'exception',
  Expired: 'unknown',
}

const arbNumber = fc.stringMatching(/^[A-Z0-9]{8,24}$/)
const arbSecret = fc.string({ minLength: 1, maxLength: 48 })

describe('AC-11: only a post signed over its exact bytes with the store’s secret verifies', () => {
  // Kills: a forged post delivering an order.
  it('AC-11: property: over generated updates and secrets, the post signed right verifies under its event_id, and the same post with one byte changed, signed with another secret, without the header, or with a hex digest does not', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNumber,
        fc.constantFrom(...AFTERSHIP_TAGS),
        arbSecret,
        arbSecret,
        fc.nat(),
        async (number, tag, secret, other, at) => {
          fc.pre(other !== secret)
          const a = adapter(secret)
          const update = trackingUpdate(number, tag)
          const raw = webhookBody(update)
          const signature = signAfterShip(raw, secret)
          const hexDigest = createHmac('sha256', Buffer.from(secret, 'utf8'))
            .update(raw)
            .digest('hex')

          const answers = await Promise.all([
            receive(a, aftershipRequest(raw, signature)),
            receive(a, aftershipRequest(changeOneByte(Buffer.from(raw, 'utf8'), at), signature)),
            receive(a, signedPost(update, other)),
            receive(a, aftershipRequest(raw, null)),
            receive(a, aftershipRequest(raw, hexDigest)),
          ])

          expect(answers.map((d) => d.verified)).toEqual([true, false, false, false, false])
          expect(answers[0]!.deliveryId).toBe(update.event_id)
        },
      ),
      { numRuns: 80 },
    )
  })

  it('AC-11: signed right, a body that is not JSON, or JSON with no event_id, is not verified; with no secret configured nothing is', async () => {
    const a = adapter(AFTERSHIP_TEST_WEBHOOK_SECRET)
    const { event_id: _dropped, ...noId } = trackingUpdate('9400100000000000000012', 'Delivered')
    const update = trackingUpdate('9400100000000000000012', 'Delivered')

    const answers = await Promise.all([
      receive(a, signedPost(update)),
      receive(
        a,
        aftershipRequest('{"event":', signAfterShip('{"event":', AFTERSHIP_TEST_WEBHOOK_SECRET)),
      ),
      receive(a, signedPost(noId)),
      receive(adapter(), signedPost(update)),
      receive(adapter(''), signedPost(update, '')),
    ])

    expect(answers.map((d) => d.verified)).toEqual([true, false, false, false, false])
  })

  it('AC-11: known answer: the header computed here as createHmac(sha256, the secret’s UTF-8 bytes).update(rawBody).digest(base64), over a secret with é and ü, verifies; keyed with the secret base64-decoded it does not', async () => {
    const secret = 'whsec_é_ü_0123456789'
    const rawBody = Buffer.from(
      '{"event":"tracking_update","event_id":"5a1f3b2c-0d4e-4f6a-8b7c-9d0e1f2a3b4c","is_tracking_first_tag":false,"msg":{"id":"trk0001","tracking_number":"1Z999AA10123456784","slug":"ups","tag":"Delivered","subtag":"Delivered_001","updated_at":"2026-11-05T10:00:00+00:00"},"ts":1793872800}',
      'utf8',
    )
    const header = createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(rawBody)
      .digest('base64')
    const decodedKey = createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(rawBody)
      .digest('base64')
    const a = adapter(secret)

    const right = await a.receiveWebhook!(rawBody, { [AFTERSHIP_SIGNATURE_HEADER]: header })
    const wrong = await a.receiveWebhook!(rawBody, { [AFTERSHIP_SIGNATURE_HEADER]: decodedKey })

    expect([right.verified, right.deliveryId, wrong.verified]).toEqual([
      true,
      '5a1f3b2c-0d4e-4f6a-8b7c-9d0e1f2a3b4c',
      false,
    ])
  })
})

const arbTag = fc.oneof(
  fc.constantFrom(...AFTERSHIP_TAGS),
  fc.stringMatching(/^[A-Za-z]{1,16}$/).filter((t) => !(t in STATUS)),
)

describe('AC-12: a tracking_update maps by the tag table; any other event is answered and dropped', () => {
  // Kills: AvailableForPickup or AttemptFail delivering an order; a non-tracking event refused and retried 14 times.
  it('AC-12: property: over generated tracking_update bodies, one aftership.tracking.v1 with the tag’s status (unknown for an unlisted tag), msg.tracking_number, msg.slug or null, and occurredAt from msg.updated_at when it reads as a date, else ts', async () => {
    const a = adapter(AFTERSHIP_TEST_WEBHOOK_SECRET)
    await fc.assert(
      fc.asyncProperty(
        arbNumber,
        arbTag,
        fc.option(fc.constantFrom('usps', 'ups', 'royal-mail', 'testing-courier'), { nil: null }),
        fc.date({
          min: new Date('2024-01-01T00:00:00Z'),
          max: new Date('2030-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.date({
          min: new Date('2024-01-01T00:00:00Z'),
          max: new Date('2030-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.constantFrom('readable', 'absent', 'unreadable'),
        async (number, tag, slug, at, updated, form) => {
          const update = trackingUpdate(number, tag, {
            slug,
            at,
            updatedAt:
              form === 'readable'
                ? aftershipTime(updated)
                : form === 'absent'
                  ? null
                  : 'not a date',
          })

          const delivery = await receive(a, signedPost(update))

          const occurred =
            form === 'readable' ? Date.parse(aftershipTime(updated)) : update.ts * 1000
          expect([delivery.verified, delivery.deliveryId]).toEqual([true, update.event_id])
          expect(
            delivery.events.map((e) => ({
              ...e,
              payload: { ...e.payload, occurredAt: Date.parse(String(e.payload['occurredAt'])) },
            })),
          ).toEqual([
            {
              type: 'aftership.tracking.v1',
              payload: {
                trackingNumber: number,
                carrier: slug,
                status: STATUS[tag] ?? 'unknown',
                occurredAt: occurred,
              },
            },
          ])
        },
      ),
      { numRuns: 120 },
    )
  })

  it('AC-12: of the nine tags only Delivered maps to delivered; AvailableForPickup and AttemptFail do not', async () => {
    const a = adapter(AFTERSHIP_TEST_WEBHOOK_SECRET)
    const statuses: Record<string, unknown> = {}
    for (const tag of AFTERSHIP_TAGS) {
      const delivery = await receive(a, signedPost(trackingUpdate('9400100000000000000013', tag)))
      statuses[tag] = delivery.events[0]?.payload['status']
    }

    expect(Object.keys(statuses).filter((t) => statuses[t] === 'delivered')).toEqual(['Delivered'])
    expect(statuses).toEqual(STATUS)
  })

  it('AC-12: property: edd_revise, tracking_pending_time and any other event, signed right, are verified under their event_id with no events', async () => {
    const a = adapter(AFTERSHIP_TEST_WEBHOOK_SECRET)
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom('edd_revise', 'tracking_pending_time'),
          fc.stringMatching(/^[a-z_]{3,24}$/).filter((e) => e !== 'tracking_update'),
        ),
        fc.constantFrom(...AFTERSHIP_TAGS),
        async (event, tag) => {
          const update = trackingUpdate('9400100000000000000014', tag, { event })

          const delivery = await receive(a, signedPost(update))

          expect(delivery).toEqual({ verified: true, deliveryId: update.event_id, events: [] })
        },
      ),
      { numRuns: 40 },
    )
  })
})
