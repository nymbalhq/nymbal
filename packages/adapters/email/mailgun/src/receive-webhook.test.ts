import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAdapter, Logger, WebhookDelivery } from '@nymbalhq/types'
import {
  changeOneCharacter,
  freshToken,
  MAILGUN_TEST_SIGNING_KEY,
  mailgunRequest,
  nowSeconds,
  signedBody,
  signMailgun,
  type MailgunEventData,
  type MailgunPostBody,
  type MailgunRequest,
  type MailgunSignature,
} from '../../../../../tests/support/mailgun'
import { createMailgunEmailAdapter } from './index.js'

// receiveWebhook on Mailgun's posts. Mailgun signs `signature.timestamp` then `signature.token` and nothing else, so
// every forgery here is in the signature fields, and a changed byte in `event-data` still verifies. Each signature
// verifies for one event id only. Time is pinned (only Date is faked), so the ±300 s window is exact.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

/** One event as receiveWebhook hands it on. */
type Draft = { type: string; payload: Record<string, unknown> }

const BOUNCED = 'mailgun.bounced.v1'
const COMPLAINED = 'mailgun.complained.v1'

/** The adapter under test, with the tests' signing key and an SMTP relay it never reaches here. */
function adapter(): EmailAdapter {
  return createMailgunEmailAdapter({
    logger,
    config: {
      from: 'store@mailgun.test',
      smtp: { host: '127.0.0.1', port: 1, user: 'postmaster@mg.mailgun.test', pass: 'smtp-pass' },
      webhookSigningKey: MAILGUN_TEST_SIGNING_KEY,
    },
  })
}

function receive(a: EmailAdapter, request: MailgunRequest): Promise<WebhookDelivery> {
  expect(typeof a.receiveWebhook, 'the adapter has no receiveWebhook').toBe('function')
  return a.receiveWebhook!(request.rawBody, request.headers)
}

const post = (a: EmailAdapter, body: MailgunPostBody) => receive(a, mailgunRequest(body))

/** The signature block of a signed body. */
const sigOf = (body: MailgunPostBody): MailgunSignature => body.signature as MailgunSignature

// --- AC-2: mapping --------------------------------------------------------------------------------------------------

/** Epoch seconds with a fraction, as Mailgun writes `event-data.timestamp`. */
const fractionalSeconds = fc
  .tuple(
    fc.integer({ min: 1_500_000_000, max: 2_000_000_000 }),
    fc.integer({ min: 1, max: 999_999 }),
  )
  .map(([s, us]) => s + us / 1_000_000)

/** A recipient as Mailgun might give it, case included: the adapter hands it on as given. */
const recipient = fc
  .tuple(fc.emailAddress(), fc.boolean())
  .map(([address, upper]) => (upper ? address.toUpperCase() : address))

/** A `message-id` header, or none: absent `message`, or a `message` whose headers lack it. */
const messageId = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9._$-]{1,40}@[a-z0-9.-]{1,20}$/),
  fc.constantFrom<null | 'no-header'>(null, 'no-header'),
)

interface Generated {
  data: MailgunEventData
  recipient: string
  messageId: string | null
}

function eventData(fields: {
  event: string
  severity?: string | undefined
}): fc.Arbitrary<Generated> {
  return fc
    .record({
      id: fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/),
      recipient,
      timestamp: fractionalSeconds,
      messageId,
    })
    .map(({ id, recipient: to, timestamp, messageId: header }) => {
      const data: MailgunEventData = { id, event: fields.event, recipient: to, timestamp }
      if (fields.severity !== undefined) data.severity = fields.severity
      if (header === 'no-header') data.message = { headers: {} }
      else if (header !== null) data.message = { headers: { 'message-id': header } }
      return { data, recipient: to, messageId: header === 'no-header' ? null : header }
    })
}

/** A severity other than `permanent`, or none. */
const notPermanent = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constant('temporary'),
  fc.string({ maxLength: 12 }).filter((s) => s !== 'permanent'),
)

/** An event other than `failed` or `complained`: the ones a merchant may also subscribe, and any other string. */
const otherEvent = fc.oneof(
  fc.constantFrom('delivered', 'opened', 'clicked', 'unsubscribed', 'accepted', 'stored'),
  fc.string({ maxLength: 16 }).filter((s) => s !== 'failed' && s !== 'complained'),
)

/** The event's time as the payload's `occurredAt` must carry it: ISO 8601, at the same millisecond. */
function expectOccurredAt(occurredAt: unknown, timestamp: number): void {
  expect(typeof occurredAt, `occurredAt ${String(occurredAt)}`).toBe('string')
  const parsed = Date.parse(occurredAt as string)
  expect(new Date(parsed).toISOString(), 'occurredAt is ISO 8601').toBe(occurredAt)
  expect(Math.abs(parsed - timestamp * 1000)).toBeLessThan(1)
}

describe('AC-2: Mailgun events map to bounces and complaints', () => {
  it('AC-2: a signed failed event of severity permanent gives one hard mailgun.bounced.v1 for its recipient, message id and time, under the event id', async () => {
    await fc.assert(
      fc.asyncProperty(eventData({ event: 'failed', severity: 'permanent' }), async (g) => {
        const delivery = await post(adapter(), signedBody(g.data))

        expect(delivery.verified).toBe(true)
        expect(delivery.deliveryId).toBe(g.data.id)
        expect(delivery.events.map((e: Draft) => e.type)).toEqual([BOUNCED])
        const payload = delivery.events[0]!.payload
        expect([payload['recipient'], payload['bounce'], payload['messageId']]).toEqual([
          g.recipient,
          'hard',
          g.messageId,
        ])
        expectOccurredAt(payload['occurredAt'], g.data.timestamp)
      }),
    )
  })

  it('AC-2: a signed failed event of any other severity, or none, gives one soft mailgun.bounced.v1, so a temporary failure never suppresses', async () => {
    await fc.assert(
      fc.asyncProperty(
        notPermanent.chain((severity) => eventData({ event: 'failed', severity })),
        async (g) => {
          const delivery = await post(adapter(), signedBody(g.data))

          expect(delivery.verified).toBe(true)
          expect(delivery.deliveryId).toBe(g.data.id)
          expect(delivery.events.map((e: Draft) => [e.type, e.payload['bounce']])).toEqual([
            [BOUNCED, 'soft'],
          ])
          const payload = delivery.events[0]!.payload
          expect([payload['recipient'], payload['messageId']]).toEqual([g.recipient, g.messageId])
          expectOccurredAt(payload['occurredAt'], g.data.timestamp)
        },
      ),
    )
  })

  it('AC-2: a signed complained event gives one mailgun.complained.v1 for its recipient, message id and time, under the event id', async () => {
    await fc.assert(
      fc.asyncProperty(eventData({ event: 'complained' }), async (g) => {
        const delivery = await post(adapter(), signedBody(g.data))

        expect(delivery.verified).toBe(true)
        expect(delivery.deliveryId).toBe(g.data.id)
        expect(delivery.events.map((e: Draft) => e.type)).toEqual([COMPLAINED])
        const payload = delivery.events[0]!.payload
        expect([payload['recipient'], payload['messageId']]).toEqual([g.recipient, g.messageId])
        expectOccurredAt(payload['occurredAt'], g.data.timestamp)
      }),
    )
  })

  it('AC-2: any other signed event is verified with no events, under the event id, so the route answers 200 and Mailgun stops retrying', async () => {
    await fc.assert(
      fc.asyncProperty(
        otherEvent.chain((event) => eventData({ event })),
        async (g) => {
          const delivery = await post(adapter(), signedBody(g.data))

          expect([delivery.verified, delivery.deliveryId, delivery.events]).toEqual([
            true,
            g.data.id,
            [],
          ])
        },
      ),
    )
  })
})

// --- AC-3: verification ---------------------------------------------------------------------------------------------

/** Pinned now: 1700000000 s, so "1.7e9" is a re-serialisation of the timestamp Mailgun would send. */
const NOW_MS = 1_700_000_000_000

/** One hard bounce, the event every verification case carries. */
const bounceData = fc
  .record({
    id: fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/),
    recipient: fc.emailAddress(),
    timestamp: fractionalSeconds,
  })
  .map(
    ({ id, recipient: to, timestamp }): MailgunEventData => ({
      id,
      event: 'failed',
      severity: 'permanent',
      recipient: to,
      timestamp,
      message: { headers: { 'message-id': `${id}@mg.mailgun.test` } },
    }),
  )

const SIGNATURE_FIELDS = ['timestamp', 'token', 'signature'] as const

/** Another signing key than the adapter's. */
const otherKey = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((k) => k !== MAILGUN_TEST_SIGNING_KEY)

/** Seconds off now that leave the window: 301 or more, either way. */
const staleOffset = fc.oneof(
  fc.constantFrom(301, -301),
  fc.integer({ min: 301, max: 10_000_000 }).chain((n) => fc.constantFrom(n, -n)),
)

/** The same number of seconds as `seconds`, written another way. */
function reserialisations(seconds: string): string[] {
  const n = Number(seconds)
  return [
    n.toExponential(),
    `${seconds}.0`,
    `0${seconds}`,
    ` ${seconds}`,
    `${seconds} `,
    `+${seconds}`,
  ]
}

/** A forgery of a signed post: the request to send, made from the real post's body. */
type Forge = (real: MailgunPostBody) => MailgunRequest

const withSignature = (
  real: MailgunPostBody,
  change: Partial<MailgunSignature>,
): MailgunPostBody => ({
  ...real,
  signature: { ...sigOf(real), ...change },
})

/** Every kind of forgery AC-3 names, each a function of the real post. */
const forgery: fc.Arbitrary<{ kind: string; forge: Forge }> = fc.oneof(
  fc.tuple(fc.constantFrom(...SIGNATURE_FIELDS), fc.nat()).map(([field, at]) => ({
    kind: `a byte of signature.${field} changed`,
    forge: (real: MailgunPostBody) =>
      mailgunRequest(withSignature(real, { [field]: changeOneCharacter(sigOf(real)[field], at) })),
  })),
  otherKey.map((key) => ({
    kind: 'signed with another key',
    forge: (real: MailgunPostBody) =>
      mailgunRequest({ ...real, signature: signMailgun(sigOf(real), key) }),
  })),
  fc.constantFrom(...SIGNATURE_FIELDS, 'the whole signature').map((missing) => ({
    kind: `${missing} missing`,
    forge: (real: MailgunPostBody) => {
      if (missing === 'the whole signature') {
        const { signature: _dropped, ...rest } = real
        return mailgunRequest(rest)
      }
      const { [missing]: _dropped, ...kept } = sigOf(real)
      return mailgunRequest({ ...real, signature: kept })
    },
  })),
  staleOffset.map((offset) => ({
    kind: `signed right with a timestamp ${offset} s off`,
    forge: (real: MailgunPostBody) =>
      mailgunRequest({
        ...real,
        signature: signMailgun(
          { timestamp: nowSeconds(offset), token: sigOf(real).token },
          MAILGUN_TEST_SIGNING_KEY,
        ),
      }),
  })),
  fc.nat().map((which) => ({
    kind: 'signature.timestamp re-serialised',
    forge: (real: MailgunPostBody) => {
      const forms = reserialisations(sigOf(real).timestamp)
      return mailgunRequest(withSignature(real, { timestamp: forms[which % forms.length]! }))
    },
  })),
  fc.nat().map((at) => ({
    kind: 'a body that is not JSON',
    forge: (real: MailgunPostBody) => {
      const bytes = mailgunRequest(real)
      return { ...bytes, rawBody: bytes.rawBody.subarray(0, at % bytes.rawBody.length) }
    },
  })),
)

describe('AC-3: only a correctly signed, fresh Mailgun signature, used for one event id, verifies', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('AC-3: each forgery of a signed post is not verified, and the real post with its token is verified after it', async () => {
    await fc.assert(
      fc.asyncProperty(bounceData, forgery, async (data, { kind, forge }) => {
        const a = adapter()
        const real = signedBody(data, { token: freshToken() })

        const forged = await receive(a, forge(real))
        const genuine = await post(a, real)

        expect([forged.verified, genuine.verified], kind).toEqual([false, true])
        expect(genuine.deliveryId).toBe(data.id)
      }),
      { numRuns: 200 },
    )
  })

  it('AC-3: "1.7e9" sent for a signature over "1700000000" is not verified, where the timestamp as signed is', async () => {
    const a = adapter()
    const real = signedBody(
      {
        id: 'mg-reserialised',
        event: 'failed',
        severity: 'permanent',
        recipient: 'r@mailgun.test',
        timestamp: 1_700_000_000.5,
      },
      { timestamp: '1700000000' },
    )

    const reserialised = await post(a, withSignature(real, { timestamp: '1.7e9' }))
    const asSigned = await post(a, real)

    expect([reserialised.verified, asSigned.verified]).toEqual([false, true])
  })

  it('AC-3: a post signed right with a timestamp up to 300 s either side of now and an unseen token is verified', async () => {
    await fc.assert(
      fc.asyncProperty(
        bounceData,
        fc.oneof(fc.constantFrom(300, -300, 0), fc.integer({ min: -300, max: 300 })),
        async (data, offset) => {
          const delivery = await post(
            adapter(),
            signedBody(data, { timestamp: nowSeconds(offset) }),
          )

          expect([delivery.verified, delivery.deliveryId], `${offset} s off`).toEqual([
            true,
            data.id,
          ])
        },
      ),
    )
  })

  it('AC-3: a second post reusing an accepted signature with other event-data and a fresh id is not verified, where the same event-data under a fresh token is', async () => {
    await fc.assert(
      fc.asyncProperty(
        bounceData,
        bounceData,
        fc.integer({ min: 0, max: 299 }),
        async (first, second, later) => {
          fc.pre(first.id !== second.id)
          const a = adapter()
          const accepted = signedBody(first)

          const original = await post(a, accepted)
          vi.setSystemTime(NOW_MS + later * 1000)
          const replayed = await post(a, { ...accepted, 'event-data': second })
          const resigned = await post(a, signedBody(second))
          vi.setSystemTime(NOW_MS)

          expect([original.verified, replayed.verified, resigned.verified]).toEqual([
            true,
            false,
            true,
          ])
          expect(resigned.deliveryId).toBe(second.id)
        },
      ),
    )
  })

  it('AC-3: a retry reusing an accepted signature with the same event-data.id is verified, with the same delivery id and events, where the same signature with another id stays refused', async () => {
    await fc.assert(
      fc.asyncProperty(
        bounceData,
        bounceData,
        fc.integer({ min: 0, max: 299 }),
        async (first, other, later) => {
          fc.pre(first.id !== other.id)
          const a = adapter()
          const accepted = signedBody(first)

          const original = await post(a, accepted)
          vi.setSystemTime(NOW_MS + later * 1000)
          const retry = await post(a, accepted)
          const replayed = await post(a, { ...accepted, 'event-data': other })
          vi.setSystemTime(NOW_MS)

          expect([original.verified, retry.verified, replayed.verified]).toEqual([
            true,
            true,
            false,
          ])
          expect(retry.deliveryId).toBe(original.deliveryId)
          expect(retry.events).toEqual(original.events)
        },
      ),
    )
  })

  it('AC-3: a changed byte in event-data alone stays verified, and the event carries the changed field, because Mailgun does not sign the body', async () => {
    await fc.assert(
      fc.asyncProperty(bounceData, fc.nat(), async (data, at) => {
        const real = signedBody(data)
        const recipientChanged = changeOneCharacter(data.recipient, at)

        const delivery = await post(adapter(), {
          ...real,
          'event-data': { ...data, recipient: recipientChanged },
        })

        expect(delivery.verified).toBe(true)
        expect(delivery.events.map((e: Draft) => e.payload['recipient'])).toEqual([
          recipientChanged,
        ])
      }),
    )
  })
})
