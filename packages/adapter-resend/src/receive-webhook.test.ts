import { randomBytes } from 'node:crypto'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAdapter, Logger, WebhookDelivery, WebhookEventDraft } from '@nymbalhq/types'
import {
  bounced,
  changeOneCharacter,
  complained,
  nowSeconds,
  other,
  RESEND_TEST_KEY,
  RESEND_TEST_SECRET,
  signedBytes,
  signedPost,
  signSvix,
  type ResendEvent,
  type ResendRequest,
} from '../../../tests/support/resend'
import { createResendEmailAdapter } from './index.js'

// receiveWebhook on Resend's posts, signed through Svix over `svix-id.svix-timestamp.body`. Time is pinned (only
// Date is faked), so the ±300 s window is exact.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const BOUNCED = 'resend.bounced.v1'
const COMPLAINED = 'resend.complained.v1'

/** Pinned now, in whole seconds. */
const NOW_MS = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_MS)
})
afterEach(() => {
  vi.useRealTimers()
})

/** The adapter under test, with `secret` (the tests' by default) and an SMTP relay it never reaches here. */
function adapter(secret: string = RESEND_TEST_SECRET): EmailAdapter {
  return createResendEmailAdapter({
    logger,
    config: {
      from: 'store@resend.test',
      smtp: { host: '127.0.0.1', port: 1, pass: 're_test_api_key' },
      webhookSecret: secret,
    },
  })
}

function receive(a: EmailAdapter, request: ResendRequest): Promise<WebhookDelivery> {
  expect(typeof a.receiveWebhook, 'the adapter has no receiveWebhook').toBe('function')
  return a.receiveWebhook!(request.rawBody, request.headers)
}

const sorted = (xs: unknown[]): unknown[] => [...xs].map(String).sort()

// --- generators -----------------------------------------------------------------------------------------------------

/** `word` with each letter's case drawn at random. */
const anyCasing = (word: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((upper) =>
      [...word].map((c, i) => (upper[i] ? c.toUpperCase() : c.toLowerCase())).join(''),
    )

/** `Permanent` as Resend writes it, and in any other casing. */
const permanent = fc.oneof(
  fc.constantFrom('Permanent', 'permanent', 'PERMANENT'),
  anyCasing('permanent'),
)

/** A bounce type that is not permanent in any casing, or none (`null`: `bounce.type` left out). */
const notPermanent = fc.oneof(
  fc.constant<string | null>(null),
  fc.constantFrom('Transient', 'Undetermined'),
  anyCasing('transient'),
  anyCasing('undetermined'),
  fc.string({ maxLength: 12 }).filter((s) => s.trim().toLowerCase() !== 'permanent'),
)

/** An event type other than a bounce or a complaint: the ones a merchant may also subscribe, and any other string. */
const otherType = fc.oneof(
  fc.constantFrom(
    'email.sent',
    'email.delivered',
    'email.delivery_delayed',
    'email.opened',
    'email.clicked',
    'email.failed',
    'contact.created',
    'domain.updated',
  ),
  fc
    .string({ maxLength: 20 })
    .filter((s) => !['email.bounced', 'email.complained'].includes(s.trim().toLowerCase())),
)

/** The fields of one event: its recipients, Resend's email id, its time and a different time for the email's own. */
const eventFields = fc.record({
  id: fc.stringMatching(/^msg_[A-Za-z0-9]{8,27}$/),
  to: fc.uniqueArray(fc.emailAddress(), { minLength: 1, maxLength: 4 }),
  emailId: fc.uuid(),
  createdAt: fc.date({
    min: new Date('2023-01-01T00:00:00.000Z'),
    max: new Date('2030-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  }),
  emailEarlierBy: fc.integer({ min: 1_000, max: 86_400_000 }),
})
type Fields = typeof eventFields extends fc.Arbitrary<infer T> ? T : never

const optsOf = (f: Fields) => ({
  emailId: f.emailId,
  createdAt: f.createdAt,
  emailCreatedAt: new Date(f.createdAt.getTime() - f.emailEarlierBy),
})

/** Each event's payload carries Resend's email id and the event's own time, never the email's. */
function expectIdAndTime(events: WebhookEventDraft[], sent: ResendEvent): void {
  for (const e of events) {
    expect(e.payload['messageId'], 'messageId is data.email_id').toBe(sent.data.email_id)
    const at = Date.parse(String(e.payload['occurredAt']))
    expect(at, `occurredAt ${String(e.payload['occurredAt'])}`).toBe(Date.parse(sent.created_at))
    expect(at, 'occurredAt is not data.created_at').not.toBe(Date.parse(sent.data.created_at))
  }
}

// --- AC-2: mapping --------------------------------------------------------------------------------------------------

describe('AC-2: Resend events map to bounces and complaints', () => {
  it('AC-2: a signed email.bounced of type Permanent, in any casing, gives one hard resend.bounced.v1 per to address, under the svix-id', async () => {
    await fc.assert(
      fc.asyncProperty(eventFields, permanent, async (f, type) => {
        const sent = bounced(f.to, type, optsOf(f))

        const delivery = await receive(adapter(), signedPost(sent, { id: f.id }))

        expect([delivery.verified, delivery.deliveryId]).toEqual([true, f.id])
        expect(
          delivery.events.map((e: WebhookEventDraft) => [e.type, e.payload['bounce']]),
        ).toEqual(f.to.map(() => [BOUNCED, 'hard']))
        expect(
          sorted(delivery.events.map((e: WebhookEventDraft) => e.payload['recipient'])),
        ).toEqual(sorted(f.to))
        expectIdAndTime(delivery.events, sent)
      }),
    )
  })

  it('AC-2: a signed email.bounced of type Transient, Undetermined, any other or none gives one soft resend.bounced.v1 per to address, so it never suppresses', async () => {
    await fc.assert(
      fc.asyncProperty(eventFields, notPermanent, async (f, type) => {
        const sent = bounced(f.to, type, optsOf(f))

        const delivery = await receive(adapter(), signedPost(sent, { id: f.id }))

        expect([delivery.verified, delivery.deliveryId]).toEqual([true, f.id])
        expect(
          delivery.events.map((e: WebhookEventDraft) => [e.type, e.payload['bounce']]),
          String(type),
        ).toEqual(f.to.map(() => [BOUNCED, 'soft']))
        expect(
          sorted(delivery.events.map((e: WebhookEventDraft) => e.payload['recipient'])),
        ).toEqual(sorted(f.to))
        expectIdAndTime(delivery.events, sent)
      }),
    )
  })

  it('AC-2: a signed email.bounced with no bounce object gives soft bounces, as one without bounce.type does', async () => {
    await fc.assert(
      fc.asyncProperty(eventFields, async (f) => {
        const sent = bounced(f.to, null, optsOf(f))
        delete sent.data.bounce

        const delivery = await receive(adapter(), signedPost(sent, { id: f.id }))

        expect([delivery.verified, delivery.deliveryId]).toEqual([true, f.id])
        expect(
          delivery.events.map((e: WebhookEventDraft) => [e.type, e.payload['bounce']]),
        ).toEqual(f.to.map(() => [BOUNCED, 'soft']))
      }),
    )
  })

  it('AC-2: a signed email.complained gives one resend.complained.v1 per to address, under the svix-id', async () => {
    await fc.assert(
      fc.asyncProperty(eventFields, async (f) => {
        const sent = complained(f.to, optsOf(f))

        const delivery = await receive(adapter(), signedPost(sent, { id: f.id }))

        expect([delivery.verified, delivery.deliveryId]).toEqual([true, f.id])
        expect(delivery.events.map((e: WebhookEventDraft) => e.type)).toEqual(
          f.to.map(() => COMPLAINED),
        )
        expect(
          sorted(delivery.events.map((e: WebhookEventDraft) => e.payload['recipient'])),
        ).toEqual(sorted(f.to))
        expectIdAndTime(delivery.events, sent)
      }),
    )
  })

  it('AC-2: any other signed type is verified with no events, under the svix-id, so the route answers 200 and Resend stops retrying', async () => {
    await fc.assert(
      fc.asyncProperty(eventFields, otherType, async (f, type) => {
        const delivery = await receive(
          adapter(),
          signedPost(other(f.to, type, optsOf(f)), { id: f.id }),
        )

        expect([delivery.verified, delivery.deliveryId, delivery.events], type).toEqual([
          true,
          f.id,
          [],
        ])
      }),
    )
  })
})

// --- AC-3: verification ---------------------------------------------------------------------------------------------

/** One hard bounce to one address, the post every verification case carries. */
const bounceFields = fc.record({
  id: fc.stringMatching(/^msg_[A-Za-z0-9]{8,27}$/),
  to: fc.emailAddress(),
  emailId: fc.uuid(),
})
const bouncePost = (f: { to: string; emailId: string }): ResendEvent =>
  bounced([f.to], 'Permanent', {
    emailId: f.emailId,
    createdAt: new Date(NOW_MS - 2_000),
    emailCreatedAt: new Date(NOW_MS - 5_000),
  })

const HEADERS = ['svix-id', 'svix-timestamp', 'svix-signature'] as const

/** Seconds off now that leave the window: 301 or more, either way. */
const staleOffset = fc.oneof(
  fc.constantFrom(301, -301),
  fc.integer({ min: 301, max: 10_000_000 }).chain((n) => fc.constantFrom(n, -n)),
)

/** A base64 key other than the tests'. */
const otherKey = fc
  .uint8Array({ minLength: 16, maxLength: 48 })
  .map((bytes) => Buffer.from(bytes))
  .filter((key) => !key.equals(RESEND_TEST_KEY))
  .map((key) => key.toString('base64'))

/** A `svix-signature` header with the right base64 signature and no `v1,` entry. */
const noV1Entry = fc.constantFrom<(signature: string) => string>(
  (s) => `v1a,${s}`,
  (s) => `v2,${s}`,
  (s) => s,
  (s) => `v1${s}`,
  (s) => `v1 ${s}`,
  () => 'v1,',
  () => '',
)

/** A forgery of a signed post: the request to send, made from the real one and the event it carries. */
type Forge = (real: ResendRequest, sent: ResendEvent) => ResendRequest

const withHeader = (real: ResendRequest, name: string, value: string): ResendRequest => ({
  ...real,
  headers: { ...real.headers, [name]: value },
})

/** Every kind of forgery AC-3 names, each a function of the real post. */
const forgery: fc.Arbitrary<{ kind: string; forge: Forge }> = fc.oneof(
  fc.nat().map((at) => ({
    kind: 'a byte of the body changed',
    forge: (real: ResendRequest) => ({
      ...real,
      rawBody: Buffer.from(changeOneCharacter(real.rawBody.toString('utf8'), at), 'utf8'),
    }),
  })),
  fc.tuple(fc.constantFrom('svix-id', 'svix-timestamp'), fc.nat()).map(([name, at]) => ({
    kind: `a byte of ${name} changed`,
    forge: (real: ResendRequest) =>
      withHeader(real, name, changeOneCharacter(real.headers[name]!, at)),
  })),
  otherKey.chain((key) =>
    fc.boolean().map((prefixed) => ({
      kind: `signed with another secret${prefixed ? ' (whsec_)' : ''}`,
      forge: (real: ResendRequest) =>
        signedBytes(real.rawBody, {
          id: real.headers['svix-id']!,
          timestamp: real.headers['svix-timestamp']!,
          secret: prefixed ? `whsec_${key}` : key,
        }),
    })),
  ),
  fc.constantFrom(...HEADERS).map((missing) => ({
    kind: `${missing} missing`,
    forge: (real: ResendRequest) => {
      const { [missing]: _dropped, ...kept } = real.headers
      return { ...real, headers: kept }
    },
  })),
  noV1Entry.map((header) => ({
    kind: `svix-signature "${header('<sig>')}" with no v1 entry`,
    forge: (real: ResendRequest) =>
      signedBytes(real.rawBody, {
        id: real.headers['svix-id']!,
        timestamp: real.headers['svix-timestamp']!,
        signatureHeader: header,
      }),
  })),
  staleOffset.map((offset) => ({
    kind: `signed right with a timestamp ${offset} s off`,
    forge: (real: ResendRequest) =>
      signedBytes(real.rawBody, {
        id: real.headers['svix-id']!,
        timestamp: nowSeconds(offset),
      }),
  })),
  fc
    .oneof(
      fc.nat().map((at) => (body: Buffer) => body.subarray(0, at % body.length)),
      fc.constant(() => Buffer.from('type=email.bounced', 'utf8')),
    )
    .map((cut) => ({
      kind: 'a body that is not JSON, signed right',
      forge: (real: ResendRequest) =>
        signedBytes(cut(real.rawBody), { id: real.headers['svix-id']! }),
    })),
)

describe('AC-3: only a correctly signed, fresh Svix post verifies', () => {
  it('AC-3: each forgery of a signed post is not verified, and the real post is verified beside it', async () => {
    await fc.assert(
      fc.asyncProperty(bounceFields, forgery, async (f, { kind, forge }) => {
        const a = adapter()
        const sent = bouncePost(f)
        const real = signedPost(sent, { id: f.id })

        const forged = await receive(a, forge(real, sent))
        const genuine = await receive(a, real)

        expect([forged.verified, genuine.verified], kind).toEqual([false, true])
        expect(genuine.deliveryId).toBe(f.id)
      }),
      { numRuns: 300 },
    )
  })

  it('AC-3: a post signed right with a timestamp up to 300 s either side of now is verified, and 301 s is not', async () => {
    await fc.assert(
      fc.asyncProperty(
        bounceFields,
        fc.oneof(fc.constantFrom(300, -300, 0), fc.integer({ min: -300, max: 300 })),
        async (f, offset) => {
          const sent = bouncePost(f)
          const at = (seconds: number) =>
            receive(adapter(), signedPost(sent, { id: f.id, timestamp: nowSeconds(seconds) }))

          const inside = await at(offset)
          const outside = await at(offset < 0 ? -301 : 301)

          expect([inside.verified, inside.deliveryId, outside.verified], `${offset} s off`).toEqual(
            [true, f.id, false],
          )
        },
      ),
    )
  })

  it('AC-3: a svix-signature of several entries where only one v1 entry matches is verified, and the same entries without it are not', async () => {
    const wrongEntry = fc.oneof(
      fc
        .uint8Array({ minLength: 32, maxLength: 32 })
        .map((b) => `v1,${Buffer.from(b).toString('base64')}`),
      fc
        .uint8Array({ minLength: 32, maxLength: 32 })
        .map((b) => `v1a,${Buffer.from(b).toString('base64')}`),
    )
    await fc.assert(
      fc.asyncProperty(
        bounceFields,
        fc.array(wrongEntry, { minLength: 1, maxLength: 4 }),
        fc.nat(),
        async (f, wrong, at) => {
          const real = signedPost(bouncePost(f), { id: f.id })
          const right = real.headers['svix-signature']!
          const entries = [...wrong]
          entries.splice(at % (entries.length + 1), 0, right)

          const withRight = await receive(
            adapter(),
            withHeader(real, 'svix-signature', entries.join(' ')),
          )
          const without = await receive(
            adapter(),
            withHeader(real, 'svix-signature', wrong.join(' ')),
          )

          expect([withRight.verified, withRight.deliveryId, without.verified]).toEqual([
            true,
            f.id,
            false,
          ])
        },
      ),
    )
  })

  it('AC-3: the secret verifies the same posts with or without its whsec_ prefix, and is keyed with its base64-decoded bytes', async () => {
    const bare = RESEND_TEST_KEY.toString('base64')
    await fc.assert(
      fc.asyncProperty(bounceFields, async (f) => {
        const body = Buffer.from(JSON.stringify(bouncePost(f)), 'utf8')
        const timestamp = nowSeconds()
        const signature = signSvix(f.id, timestamp, body, bare)
        const request = signedBytes(body, {
          id: f.id,
          timestamp,
          signatureHeader: () => `v1,${signature}`,
        })
        // Keyed with the secret's text rather than its decoded bytes, whole or after whsec_: what a verifier that
        // skips the base64 decode gets.
        const textKeyed = [RESEND_TEST_SECRET, bare].map((text) =>
          signedBytes(body, {
            id: f.id,
            timestamp,
            secret: Buffer.from(text, 'utf8').toString('base64'),
          }),
        )

        const results = [
          await receive(adapter(RESEND_TEST_SECRET), request),
          await receive(adapter(bare), request),
          ...(await Promise.all(textKeyed.map((r) => receive(adapter(RESEND_TEST_SECRET), r)))),
          ...(await Promise.all(textKeyed.map((r) => receive(adapter(bare), r)))),
        ]

        expect(results.map((d) => d.verified)).toEqual([true, true, false, false, false, false])
        expect(results[0]!.events).toEqual(results[1]!.events)
      }),
    )
  })

  // Svix's own documented example, so the scheme is checked against an answer these tests' signer did not compute.
  it("AC-3: Svix's published example post verifies with its secret at its time, and not 301 s later or with one body byte changed", async () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
    const example: ResendRequest = {
      rawBody: Buffer.from('{"test": 2432232314}', 'utf8'),
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
        'svix-timestamp': '1614265330',
        'svix-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
      },
    }
    const changed = { ...example, rawBody: Buffer.from('{"test": 2432232315}', 'utf8') }

    vi.setSystemTime(1_614_265_330_000)
    const atItsTime = await receive(adapter(secret), example)
    const bodyChanged = await receive(adapter(secret), changed)
    vi.setSystemTime(1_614_265_631_000)
    const later = await receive(adapter(secret), example)

    expect([atItsTime.verified, atItsTime.deliveryId, atItsTime.events]).toEqual([
      true,
      example.headers['svix-id'],
      [],
    ])
    expect([bodyChanged.verified, later.verified]).toEqual([false, false])
  })

  it('AC-3: a post whose signature is right but whose secret is unset on the adapter is not verified', async () => {
    const real = signedPost(
      bounced([`x-${randomBytes(4).toString('hex')}@resend.test`], 'Permanent'),
    )
    const without = createResendEmailAdapter({
      logger,
      config: {
        from: 'store@resend.test',
        smtp: { host: '127.0.0.1', port: 1, pass: 're_test_api_key' },
      },
    })

    const [unset, set] = [await receive(without, real), await receive(adapter(), real)]

    expect([unset.verified, set.verified]).toEqual([false, true])
  })

  it('AC-3: a secret that decodes to no key is no secret: a post signed with the empty key, or with any other, is not verified', async () => {
    const noKey = fc.constantFrom('whsec_', '!!!!', 'whsec_!!!!', '=', 'whsec_====', '%')
    // HMAC pads its key with zero bytes, so a key of only zeros signs as the empty key does.
    const nonZeroKey = otherKey.filter((key) => Buffer.from(key, 'base64').some((b) => b !== 0))
    await fc.assert(
      fc.asyncProperty(bounceFields, noKey, nonZeroKey, async (f, secret, other) => {
        const body = Buffer.from(JSON.stringify(bouncePost(f)), 'utf8')
        const sign = (key: string) =>
          receive(adapter(secret), signedBytes(body, { id: f.id, secret: key }))

        const emptyKeyed = await sign(secret)
        const bareEmpty = await sign('')
        const otherKeyed = await sign(other)
        const genuine = await receive(adapter(), signedBytes(body, { id: f.id }))

        expect(
          [emptyKeyed.verified, bareEmpty.verified, otherKeyed.verified, genuine.verified],
          secret,
        ).toEqual([false, false, false, true])
        expect([emptyKeyed.deliveryId, emptyKeyed.events]).toEqual(['', []])
      }),
    )
  })
})
