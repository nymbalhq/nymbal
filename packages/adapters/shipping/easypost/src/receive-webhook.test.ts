import { createHmac } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Logger, ShippingAdapter, WebhookDelivery } from '@nymbalhq/types'
import {
  changeOneByte,
  EASYPOST_SIGNATURE_PREFIX,
  EASYPOST_TEST_WEBHOOK_SECRET,
  EASYPOST_TRACKER_DESCRIPTIONS,
  EASYPOST_TRACKER_STATUSES,
  easypostRequest,
  easypostTime,
  eventBody,
  signEasyPost,
  signedPost,
  trackerEvent,
  type EasyPostEvent,
  type EasyPostRequest,
  type EasyPostTracker,
} from '../../../../../tests/support/easypost'
import { createEasyPostShippingAdapter } from './index.js'

// receiveWebhook on EasyPost's posts. EasyPost signs the whole raw body (HMAC-SHA256, keyed with the webhook secret
// NFKD-normalised), so any changed byte, another secret, a missing or mis-prefixed header, or a body that is not JSON
// is refused; a Tracker Event is one easypost.tracking.v1 under the Event's id, mapped per EasyPost's statuses, and
// any other Event is verified with no events, so EasyPost stops retrying it.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const TRACKING = 'easypost.tracking.v1'

/** One event as receiveWebhook hands it on. */
type Draft = { type: string; payload: Record<string, unknown> }

/** The adapter under test, with the tests' webhook secret unless another is given. */
function adapter(webhookSecret: string = EASYPOST_TEST_WEBHOOK_SECRET): ShippingAdapter {
  return createEasyPostShippingAdapter({ logger, config: { webhookSecret } })
}

function receive(a: ShippingAdapter, request: EasyPostRequest): Promise<WebhookDelivery> {
  expect(typeof a.receiveWebhook, 'the adapter has no receiveWebhook').toBe('function')
  return a.receiveWebhook!(request.rawBody, request.headers)
}

// --- AC-2: mapping --------------------------------------------------------------------------------------------------

/** EasyPost's status, and the status the payload must carry (the table in the adapter's docs). */
const MAPPED: Record<(typeof EASYPOST_TRACKER_STATUSES)[number], string> = {
  pre_transit: 'pre_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  available_for_pickup: 'out_for_delivery',
  delivered: 'delivered',
  return_to_sender: 'returned',
  failure: 'exception',
  error: 'exception',
  cancelled: 'exception',
  unknown: 'unknown',
}

const KNOWN: ReadonlySet<string> = new Set(EASYPOST_TRACKER_STATUSES)

/** A status EasyPost does not list: any string, and the names an object lookup would find on its prototype. */
const unlistedStatus = fc
  .oneof(
    fc.string({ maxLength: 24 }),
    fc.stringMatching(/^[a-z_]{1,24}$/),
    fc.constantFrom('constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'),
  )
  .filter((s) => !KNOWN.has(s))

const status = fc.oneof(
  fc.constantFrom(...EASYPOST_TRACKER_STATUSES).map((s) => ({ given: s, expected: MAPPED[s] })),
  unlistedStatus.map((s) => ({ given: s, expected: 'unknown' })),
)

/** A time as EasyPost writes it, from 2015 to 2035. */
const time = fc
  .date({ min: new Date('2015-01-01T00:00:00Z'), max: new Date('2035-01-01T00:00:00Z') })
  .filter((d) => !Number.isNaN(d.getTime()))
  .map(easypostTime)

/** A carrier as EasyPost names it, null, or left out: the payload's carrier is the string, or null. */
const carrier = fc.oneof(
  fc
    .constantFrom('USPS', 'UPS', 'FedEx', 'DHLExpress', 'CanadaPost', 'RoyalMail')
    .map((c) => ({ given: c as string | null | undefined, expected: c as string | null })),
  fc.constant({ given: null as string | null | undefined, expected: null as string | null }),
  fc.constant({ given: undefined as string | null | undefined, expected: null as string | null }),
)

interface GeneratedTracker {
  event: EasyPostEvent
  trackingCode: string
  carrier: string | null
  status: string
  /** The instant the payload's occurredAt must be. */
  occurredAt: string
}

/**
 * A Tracker Event: either kind, any status, the Tracker's `updated_at` present, or missing so the Event's own
 * `updated_at` (another time, and not its `created_at`) is the one the payload must carry.
 */
const trackerEvents: fc.Arbitrary<GeneratedTracker> = fc
  .record({
    id: fc.stringMatching(/^[0-9a-f]{32}$/).map((h) => `evt_${h}`),
    description: fc.constantFrom(...EASYPOST_TRACKER_DESCRIPTIONS),
    trackingCode: fc.stringMatching(/^[A-Z0-9]{8,30}$/),
    carrier,
    status,
    trackerAt: fc.option(time, { nil: undefined }),
    eventAt: time,
    eventCreatedAt: time,
  })
  .map(
    ({
      id,
      description,
      trackingCode,
      carrier: c,
      status: s,
      trackerAt,
      eventAt,
      eventCreatedAt,
    }) => {
      const result: EasyPostTracker = {
        id: `trk_${id.slice(4)}`,
        object: 'Tracker',
        mode: 'test',
        tracking_code: trackingCode,
        status: s.given,
      }
      if (c.given !== undefined) result.carrier = c.given
      if (trackerAt !== undefined) result.updated_at = trackerAt
      const event: EasyPostEvent = {
        id,
        object: 'Event',
        description,
        mode: 'test',
        created_at: eventCreatedAt,
        updated_at: eventAt,
        result,
      }
      return {
        event,
        trackingCode,
        carrier: c.expected,
        status: s.expected,
        occurredAt: trackerAt ?? eventAt,
      }
    },
  )

/** An Event description other than the two that carry a Tracker. */
const otherDescription = fc
  .oneof(
    fc.constantFrom(
      'batch.created',
      'batch.updated',
      'scan_form.updated',
      'shipment.invoice.created',
      'refund.successful',
      'insurance.purchased',
      'payment.completed',
      'report.available',
    ),
    fc.string({ maxLength: 24 }),
  )
  .filter((d) => !(EASYPOST_TRACKER_DESCRIPTIONS as readonly string[]).includes(d))

describe('AC-2: EasyPost tracker events map to tracking updates', () => {
  it('AC-2: each EasyPost status, in a signed tracker.updated, is handed on as the status its table names', async () => {
    const a = adapter()
    for (const given of EASYPOST_TRACKER_STATUSES) {
      const delivery = await receive(a, signedPost(trackerEvent('9400100000000000000001', given)))

      expect(delivery.verified, given).toBe(true)
      expect(
        delivery.events.map((e: Draft) => [e.type, e.payload['status']]),
        given,
      ).toEqual([[TRACKING, MAPPED[given]]])
    }
  })

  it('AC-2: a signed tracker Event of either kind gives one easypost.tracking.v1 under the Event id, its tracking number, carrier or null, mapped status (unknown for an unlisted one) and time from the Tracker, or the Event when the Tracker has none', async () => {
    await fc.assert(
      fc.asyncProperty(trackerEvents, async (g) => {
        const delivery = await receive(adapter(), signedPost(g.event))

        expect(delivery.verified).toBe(true)
        expect(delivery.deliveryId).toBe(g.event.id)
        expect(delivery.events.map((e: Draft) => e.type)).toEqual([TRACKING])
        const payload = delivery.events[0]!.payload
        expect([payload['trackingNumber'], payload['carrier'], payload['status']]).toEqual([
          g.trackingCode,
          g.carrier,
          g.status,
        ])
        expect(typeof payload['occurredAt'], `occurredAt ${String(payload['occurredAt'])}`).toBe(
          'string',
        )
        expect(Date.parse(payload['occurredAt'] as string)).toBe(Date.parse(g.occurredAt))
      }),
      { numRuns: 200 },
    )
  })

  it('AC-2: any other signed Event is verified with no events, under the Event id, so the route answers 200 and EasyPost stops retrying', async () => {
    await fc.assert(
      fc.asyncProperty(trackerEvents, otherDescription, async (g, description) => {
        const event: EasyPostEvent = { ...g.event, description }

        const delivery = await receive(adapter(), signedPost(event))

        expect([delivery.verified, delivery.deliveryId, delivery.events]).toEqual([
          true,
          event.id,
          [],
        ])
      }),
    )
  })
})

// --- AC-3: verification ---------------------------------------------------------------------------------------------

/** A signed post's parts: the exact body and the header it was signed with. */
interface Signed {
  body: string
  header: string
}

type Forge = (real: Signed) => EasyPostRequest

/** Another secret than the tests', NFKD-distinct from it, so it is truly another key. */
const otherSecret = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((s) => s.normalize('NFKD') !== EASYPOST_TEST_WEBHOOK_SECRET.normalize('NFKD'))

/** The header's hex with something other than `hmac-sha256-hex=` in front of it, or nothing. */
const MISPREFIXED: ReadonlyArray<(hex: string) => string> = [
  (hex) => hex,
  (hex) => `sha256=${hex}`,
  (hex) => `hmac-sha256-hex:${hex}`,
  (hex) => `hmac-sha256=${hex}`,
  (hex) => `${EASYPOST_SIGNATURE_PREFIX}${EASYPOST_SIGNATURE_PREFIX}${hex}`,
]

const hexOf = (header: string): string => header.slice(EASYPOST_SIGNATURE_PREFIX.length)

/** Every forgery AC-3 names, each a function of the real post. */
const forgery: fc.Arbitrary<{ kind: string; forge: Forge }> = fc.oneof(
  fc.nat().map((at) => ({
    kind: 'one byte of the body changed after signing',
    forge: (real: Signed) =>
      easypostRequest(changeOneByte(Buffer.from(real.body), at), real.header),
  })),
  fc.constant({
    kind: 'the body re-serialised with other spacing',
    forge: (real: Signed) =>
      easypostRequest(JSON.stringify(JSON.parse(real.body), null, 2), real.header),
  }),
  otherSecret.map((secret) => ({
    kind: 'signed with another secret',
    forge: (real: Signed) => easypostRequest(real.body, signEasyPost(real.body, secret)),
  })),
  fc.constant({
    kind: 'no signature header',
    forge: (real: Signed) => easypostRequest(real.body, null),
  }),
  fc.nat().map((which) => ({
    kind: 'a header without the hmac-sha256-hex= prefix',
    forge: (real: Signed) =>
      easypostRequest(real.body, MISPREFIXED[which % MISPREFIXED.length]!(hexOf(real.header))),
  })),
  fc.nat().map((at) => ({
    kind: 'a body that is not JSON, signed right',
    forge: (real: Signed) => {
      const cut = real.body.slice(0, at % real.body.length)
      return easypostRequest(cut, signEasyPost(cut, EASYPOST_TEST_WEBHOOK_SECRET))
    },
  })),
  fc.constantFrom('not json', '<html></html>', 'evt_123', '{"id":').map((text) => ({
    kind: `the text ${JSON.stringify(text)}, signed right`,
    forge: () => easypostRequest(text, signEasyPost(text, EASYPOST_TEST_WEBHOOK_SECRET)),
  })),
)

/** The known-answer vector: a secret holding é (U+00E9) and ﬁ (U+FB01), whose NFKD form is other bytes. */
const UNICODE_SECRET = 'café-ﬁle-webhook-secret'
const KNOWN_BODY =
  '{"id":"evt_known_answer","object":"Event","description":"tracker.updated","mode":"test","result":{"id":"trk_known_answer","object":"Tracker","tracking_code":"9400100000000000000000","carrier":"USPS","status":"delivered","updated_at":"2026-10-29T12:00:00Z"}}'

/** HMAC-SHA256 hex of `body` keyed with `key`, as EasyPost's client libraries compute it: not through signEasyPost. */
const hmacHex = (key: Buffer, body: string): string =>
  createHmac('sha256', key).update(Buffer.from(body, 'utf8')).digest('hex')

describe('AC-3: only a post signed over its exact bytes with the store’s secret verifies', () => {
  it('AC-3: each forgery of a signed post is not verified, and the real post is verified after it, under its Event id', async () => {
    await fc.assert(
      fc.asyncProperty(trackerEvents, forgery, async (g, { kind, forge }) => {
        const a = adapter()
        const body = eventBody(g.event)
        const real: Signed = { body, header: signEasyPost(body, EASYPOST_TEST_WEBHOOK_SECRET) }

        const forged = await receive(a, forge(real))
        const genuine = await receive(a, easypostRequest(real.body, real.header))

        expect([forged.verified, genuine.verified], kind).toEqual([false, true])
        expect(genuine.deliveryId).toBe(g.event.id)
      }),
      { numRuns: 300 },
    )
  })

  it('AC-3: a body signed right under any secret verifies on the adapter holding that secret, and on no adapter holding another', async () => {
    await fc.assert(
      fc.asyncProperty(
        trackerEvents,
        fc.string({ minLength: 1, maxLength: 64 }),
        otherSecret,
        async (g, secret, other) => {
          fc.pre(secret.normalize('NFKD') !== other.normalize('NFKD'))
          const request = signedPost(g.event, secret)

          const own = await receive(adapter(secret), request)
          const another = await receive(adapter(other), request)

          expect([own.verified, another.verified]).toEqual([true, false])
          expect(own.deliveryId).toBe(g.event.id)
        },
      ),
    )
  })

  it('AC-3: known answer across Unicode forms: with a secret holding é and ﬁ, the header keyed with its NFKD bytes verifies, on the secret as written and as decomposed, and the header keyed with its bytes as written does not', async () => {
    const decomposed = UNICODE_SECRET.normalize('NFKD')
    const normalised = `hmac-sha256-hex=${hmacHex(Buffer.from(decomposed, 'utf8'), KNOWN_BODY)}`
    const asWritten = `hmac-sha256-hex=${hmacHex(Buffer.from(UNICODE_SECRET, 'utf8'), KNOWN_BODY)}`
    // The vector itself, so the reference computation above cannot drift with the adapter.
    expect(normalised).toBe(
      'hmac-sha256-hex=f2743ac681008ca05d8c3bd5d5f3c2b0c71b56d18f590aa1e8279456454f1034',
    )
    expect(decomposed).not.toBe(UNICODE_SECRET)
    expect(asWritten).not.toBe(normalised)

    const written = adapter(UNICODE_SECRET)
    const right = await receive(written, easypostRequest(KNOWN_BODY, normalised))
    const unnormalised = await receive(written, easypostRequest(KNOWN_BODY, asWritten))
    const onDecomposed = await receive(adapter(decomposed), easypostRequest(KNOWN_BODY, normalised))

    expect([right.verified, unnormalised.verified, onDecomposed.verified]).toEqual([
      true,
      false,
      true,
    ])
    expect(right.deliveryId).toBe('evt_known_answer')
    expect(onDecomposed.deliveryId).toBe(right.deliveryId)
  })
})
