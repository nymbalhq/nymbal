import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailAdapter, Logger, WebhookDelivery, WebhookEventDraft } from '@nymbalhq/types'
import {
  CONFIRMATION_FIELDS,
  certificateAnswer,
  changeOneCharacter,
  fakeFetch,
  freshCertUrl,
  neverAnswers,
  notification,
  NOTIFICATION_FIELDS,
  OTHER_CERT_MARK,
  redirectingFetch,
  SES_SUBJECT,
  SES_TEST_REGION,
  SES_TEST_TOPIC,
  sesBounce,
  sesComplaint,
  sesOther,
  sesOtherSigner,
  sesTestSigner,
  signedFields,
  snsMessageId,
  signedSnsPost,
  signSns,
  snsAnswers,
  snsRequest,
  subscriptionConfirmation,
  unsubscribeConfirmation,
  type FakeFetch,
  type FetchCall,
  type KindField,
  type SesMessage,
  type SesRequest,
  type SnsMessage,
  type UnsignedSnsMessage,
} from '../../../../../tests/support/ses'
import { createSesEmailAdapter, type SesEmailAdapterConfig } from './index.js'

// receiveWebhook on SNS posts of SES feedback. Each message is signed with a self-signed test certificate; `fetch` is
// a fake (vi.stubGlobal) that answers that certificate for any URL, on any host, so only the adapter's own rules can
// refuse a URL, and every call it makes is recorded.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const BOUNCED = 'ses.bounced.v1'
const COMPLAINED = 'ses.complained.v1'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A fake `fetch` installed as the global one, answering with `answer` (SNS as the fake sees it, by default). */
function stubFetch(
  answer: (url: string, call: FetchCall) => Response | Promise<Response> = snsAnswers,
): FakeFetch {
  const net = fakeFetch(answer)
  vi.stubGlobal('fetch', net.fetch)
  return net
}

/** The adapter under test, on `topicArn` (the tests' by default; `null` leaves it out), with an SMTP relay it never
 * reaches here. */
function adapter(topicArn: string | null = SES_TEST_TOPIC): EmailAdapter {
  const config = {
    from: 'store@ses.test',
    region: SES_TEST_REGION,
    smtp: { host: '127.0.0.1', port: 1, user: 'AKIASESTESTUSER', pass: 'ses-smtp-password' },
    ...(topicArn !== null && { topicArn }),
  }
  return createSesEmailAdapter({ logger, config: config as SesEmailAdapterConfig })
}

async function receive(a: EmailAdapter, request: SesRequest): Promise<WebhookDelivery> {
  expect(typeof a.receiveWebhook, 'the adapter has no receiveWebhook').toBe('function')
  return a.receiveWebhook!(request.rawBody, request.headers)
}

const sorted = (xs: unknown[]): unknown[] => [...xs].map(String).sort()

// --- generators -----------------------------------------------------------------------------------------------------

const instant = fc
  .date({
    min: new Date('2023-01-01T00:00:00.000Z'),
    max: new Date('2030-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  })
  .map((d) => d.getTime())

/** One Notification's fields: SNS's id, SES's mail id, recipients, and three distinct times. */
const feedbackFields = fc.record({
  messageId: fc.uuid(),
  mailMessageId: fc.stringMatching(/^[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{12}-000000$/),
  to: fc.uniqueArray(fc.emailAddress(), { minLength: 1, maxLength: 4 }),
  at: instant,
  mailEarlierBy: fc.integer({ min: 1_000, max: 86_400_000 }),
  snsLaterBy: fc.integer({ min: 1, max: 60_000 }),
  kindField: fc.constantFrom<KindField>('notificationType', 'eventType'),
  subject: fc.option(fc.constantFrom(SES_SUBJECT, 'Bounce for store@ses.test'), { nil: null }),
  version: fc.constantFrom('1', '2'),
})
type Fields = typeof feedbackFields extends fc.Arbitrary<infer T> ? T : never

const sesOpts = (f: Fields) => ({
  kindField: f.kindField,
  mailMessageId: f.mailMessageId,
  at: new Date(f.at).toISOString(),
  mailTimestamp: new Date(f.at - f.mailEarlierBy).toISOString(),
})

/** `ses` in a signed Notification under `f`'s id, subject, version and SNS time. */
const signedNotification = (ses: SesMessage, f: Fields): SesRequest =>
  signedSnsPost(
    notification(ses, {
      messageId: f.messageId,
      subject: f.subject,
      version: f.version,
      timestamp: new Date(f.at + f.snsLaterBy).toISOString(),
    }),
  )

/** Each event's payload carries SES's mail id and the feedback's own time: never the mail's, never SNS's. */
function expectIdAndTime(events: WebhookEventDraft[], ses: SesMessage, f: Fields): void {
  const feedbackAt = ses.bounce?.timestamp ?? ses.complaint?.timestamp
  for (const e of events) {
    expect(e.payload['messageId'], 'messageId is mail.messageId').toBe(ses.mail!.messageId)
    const at = Date.parse(String(e.payload['occurredAt']))
    expect(at, `occurredAt ${String(e.payload['occurredAt'])}`).toBe(Date.parse(feedbackAt!))
    expect(at, 'occurredAt is not mail.timestamp').not.toBe(Date.parse(ses.mail!.timestamp))
    expect(at, "occurredAt is not SNS's Timestamp").not.toBe(f.at + f.snsLaterBy)
  }
}

// --- AC-2: mapping --------------------------------------------------------------------------------------------------

describe('AC-2: SES feedback maps to bounces and complaints', () => {
  it('AC-2: a signed Permanent Bounce, under notificationType or eventType, with or without Subject, gives one hard ses.bounced.v1 per bounced recipient under the MessageId', async () => {
    stubFetch()
    await fc.assert(
      fc.asyncProperty(feedbackFields, async (f) => {
        const ses = sesBounce(f.to, 'Permanent', sesOpts(f))

        const delivery = await receive(adapter(), signedNotification(ses, f))

        expect([delivery.verified, delivery.deliveryId]).toEqual([true, f.messageId])
        expect(
          delivery.events.map((e: WebhookEventDraft) => [e.type, e.payload['bounce']]),
        ).toEqual(f.to.map(() => [BOUNCED, 'hard']))
        expect(
          sorted(delivery.events.map((e: WebhookEventDraft) => e.payload['recipient'])),
        ).toEqual(sorted(f.to))
        expectIdAndTime(delivery.events, ses, f)
      }),
    )
  })

  it('AC-2: a signed Transient or Undetermined Bounce gives one soft ses.bounced.v1 per bounced recipient, so it never suppresses', async () => {
    stubFetch()
    await fc.assert(
      fc.asyncProperty(
        feedbackFields,
        fc.constantFrom('Transient', 'Undetermined'),
        async (f, bounceType) => {
          const ses = sesBounce(f.to, bounceType, sesOpts(f))

          const delivery = await receive(adapter(), signedNotification(ses, f))

          expect([delivery.verified, delivery.deliveryId]).toEqual([true, f.messageId])
          expect(
            delivery.events.map((e: WebhookEventDraft) => [e.type, e.payload['bounce']]),
            bounceType,
          ).toEqual(f.to.map(() => [BOUNCED, 'soft']))
          expect(
            sorted(delivery.events.map((e: WebhookEventDraft) => e.payload['recipient'])),
          ).toEqual(sorted(f.to))
          expectIdAndTime(delivery.events, ses, f)
        },
      ),
    )
  })

  it('AC-2: a signed Complaint gives one ses.complained.v1 per complained recipient under the MessageId', async () => {
    stubFetch()
    await fc.assert(
      fc.asyncProperty(feedbackFields, async (f) => {
        const ses = sesComplaint(f.to, sesOpts(f))

        const delivery = await receive(adapter(), signedNotification(ses, f))

        expect([delivery.verified, delivery.deliveryId]).toEqual([true, f.messageId])
        expect(delivery.events.map((e: WebhookEventDraft) => e.type)).toEqual(
          f.to.map(() => COMPLAINED),
        )
        expect(
          sorted(delivery.events.map((e: WebhookEventDraft) => e.payload['recipient'])),
        ).toEqual(sorted(f.to))
        expectIdAndTime(delivery.events, ses, f)
      }),
    )
  })

  it('AC-2: a signed Delivery, or any other kind SES publishes, is verified with no events under the MessageId', async () => {
    stubFetch()
    const otherKind = fc.constantFrom(
      'Delivery',
      'Send',
      'Reject',
      'Open',
      'Click',
      'DeliveryDelay',
      'Rendering Failure',
      'Subscription',
    )
    await fc.assert(
      fc.asyncProperty(feedbackFields, otherKind, async (f, kind) => {
        const delivery = await receive(
          adapter(),
          signedNotification(sesOther(kind, f.to, sesOpts(f)), f),
        )

        expect([delivery.verified, delivery.deliveryId, delivery.events], kind).toEqual([
          true,
          f.messageId,
          [],
        ])
      }),
    )
  })

  it("AC-2: SES's AmazonSnsSubscriptionSucceeded test notification, which carries no mail, is verified with no events", async () => {
    stubFetch()
    await fc.assert(
      fc.asyncProperty(feedbackFields, async (f) => {
        const ses = {
          notificationType: 'AmazonSnsSubscriptionSucceeded',
          message: `You have successfully subscribed your Amazon SNS topic '${SES_TEST_TOPIC}' to receive 'Bounce' notifications from Amazon SES for identity 'ses.test'.`,
        }

        const delivery = await receive(adapter(), signedNotification(ses, f))

        expect([delivery.verified, delivery.deliveryId, delivery.events]).toEqual([
          true,
          f.messageId,
          [],
        ])
      }),
    )
  })
})

// --- AC-3: verification ---------------------------------------------------------------------------------------------

/** One hard bounce to one address, in a Notification with a Subject, unsigned: the message the forgeries start from. */
const bounceFields = fc.record({
  messageId: fc.uuid(),
  to: fc.emailAddress(),
  version: fc.constantFrom('1', '2'),
})
const unsignedBounce = (f: { messageId: string; to: string; version: string }, certUrl?: string) =>
  notification(sesBounce([f.to], 'Permanent'), {
    messageId: f.messageId,
    version: f.version,
    ...(certUrl !== undefined && { certUrl }),
  })

/** A forgery: the post to send, made from the unsigned message and its correct signing. */
type Forge = (unsigned: UnsignedSnsMessage, real: SnsMessage) => SesRequest

const field = (m: SnsMessage, name: string): string =>
  String((m as unknown as Record<string, unknown>)[name])

/** A `SignatureVersion` that is neither `1` nor `2`. */
const otherVersion = fc.oneof(
  fc.constantFrom('3', '0', '', '2.0', 'v2', ' 2', '12'),
  fc.string({ maxLength: 4 }).filter((v) => v !== '1' && v !== '2'),
)

/** An order of `fields` other than SNS's. */
const otherOrder = (fields: readonly string[]) =>
  fc
    .shuffledSubarray([...fields], { minLength: fields.length, maxLength: fields.length })
    .filter((order) => order.join() !== fields.join())

/** Every forgery of a signed Notification AC-3 names, each a function of the real one. */
const notificationForgery: fc.Arbitrary<{ kind: string; forge: Forge }> = fc.oneof(
  fc.tuple(fc.constantFrom(...NOTIFICATION_FIELDS), fc.nat()).map(([name, at]) => ({
    kind: `${name} changed after signing`,
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) =>
      snsRequest({ ...real, [name]: changeOneCharacter(field(real, name), at) }),
  })),
  fc.constant({
    kind: 'Subject removed after signing',
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) => {
      const { Subject: _dropped, ...rest } = real
      return snsRequest(rest)
    },
  }),
  fc.constant({
    kind: 'Subject added after signing without one',
    forge: (unsigned: UnsignedSnsMessage) => {
      const { Subject, ...noSubject } = unsigned
      return snsRequest({ ...signSns(noSubject), Subject })
    },
  }),
  fc.constant({
    kind: 'signed with another key',
    forge: (unsigned: UnsignedSnsMessage) => snsRequest(signSns(unsigned, sesOtherSigner().key)),
  }),
  otherVersion.map((version) => ({
    kind: `SignatureVersion "${version}"`,
    forge: (unsigned: UnsignedSnsMessage) =>
      snsRequest(
        signSns({ ...unsigned, SignatureVersion: version }, sesTestSigner().key, {
          hash: 'sha256',
        }),
      ),
  })),
  fc.constantFrom(['1', 'sha256'] as const, ['2', 'sha1'] as const).map(([version, hash]) => ({
    kind: `SignatureVersion ${version} signed with ${hash}`,
    forge: (unsigned: UnsignedSnsMessage) =>
      snsRequest(
        signSns({ ...unsigned, SignatureVersion: version }, sesTestSigner().key, { hash }),
      ),
  })),
  otherOrder(NOTIFICATION_FIELDS).map((order) => ({
    kind: `signed in the order ${order.join(',')}`,
    forge: (unsigned: UnsignedSnsMessage) =>
      snsRequest(signSns(unsigned, sesTestSigner().key, { order })),
  })),
  fc.nat().map((at) => ({
    kind: 'a character of Signature changed',
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) =>
      snsRequest({ ...real, Signature: changeOneCharacter(real.Signature, at % 300) }),
  })),
  fc.constant({
    kind: "SigningCertURL swapped for an allowed one serving another key's certificate",
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) =>
      snsRequest({
        ...real,
        SigningCertURL: `https://sns.${SES_TEST_REGION}.amazonaws.com/${OTHER_CERT_MARK}-${real.MessageId}.pem`,
      }),
  }),
  fc.constantFrom('Signature', 'SigningCertURL', 'SignatureVersion').map((missing) => ({
    kind: `${missing} missing`,
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) => {
      const { [missing as keyof SnsMessage]: _dropped, ...kept } = real
      return snsRequest(kept)
    },
  })),
  fc.nat().map((at) => ({
    kind: 'a body cut short, so it is not JSON',
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) => {
      const body = snsRequest(real)
      return { ...body, rawBody: body.rawBody.subarray(0, 1 + (at % (body.rawBody.length - 1))) }
    },
  })),
)

/** A certificate URL the adapter must refuse without fetching it: not https, not SNS's host, or not a `.pem`. */
const refusedCertUrl = fc.constantFrom(
  'http://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem',
  'ftp://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem',
  'file:///etc/sns.us-east-1.amazonaws.com.pem',
  'https://sns.evil.com/SimpleNotificationService-x.pem',
  'https://sns.us-east-1.amazonaws.com.evil.com/SimpleNotificationService-x.pem',
  'https://sns.us-east-1.amazonaws.com@evil.com/x.pem',
  'https://sns.us-east-1.amazonaws.com:443@evil.com/x.pem',
  'https://evil.com/sns.us-east-1.amazonaws.com/x.pem',
  'https://evil.com/x.pem?host=sns.us-east-1.amazonaws.com',
  'https://evil.sns.us-east-1.amazonaws.com/x.pem',
  'https://xsns.us-east-1.amazonaws.com/x.pem',
  'https://sns-us-east-1.amazonaws.com/x.pem',
  'https://sns.us-east-1.amazonaws.co/x.pem',
  'https://sns.us-east-1.amazonaws.com.cn.evil.com/x.pem',
  'https://sns.us_east_1.amazonaws.com/x.pem',
  'https://sns.s3.amazonaws.com/x.pem',
  'https://sns.s3-accelerate.amazonaws.com/x.pem',
  'https://sns.us-east-1.amazonaws.com/x',
  'https://sns.us-east-1.amazonaws.com/x.pem.txt',
  'https://sns.us-east-1.amazonaws.com/',
  'sns.us-east-1.amazonaws.com/x.pem',
  'not a url',
  '',
)

/** A message of each type SNS posts, for the store's topic unless `topicArn` names another, unsigned. */
const anyType = fc.constantFrom(
  'Notification',
  'SubscriptionConfirmation',
  'UnsubscribeConfirmation',
)
function messageOf(
  type: string,
  opts: { messageId?: string; topicArn?: string; version?: string; certUrl?: string } = {},
): UnsignedSnsMessage {
  if (type === 'SubscriptionConfirmation') return subscriptionConfirmation(opts)
  if (type === 'UnsubscribeConfirmation') return unsubscribeConfirmation(opts)
  return notification(sesBounce(['someone@ses.test'], 'Permanent'), opts)
}

/** A topic other than the store's: another account's, or one a character, a case or a suffix away. */
const otherTopic = fc.oneof(
  fc.constantFrom(
    `${SES_TEST_TOPIC}x`,
    SES_TEST_TOPIC.slice(0, -1),
    SES_TEST_TOPIC.toUpperCase(),
    ` ${SES_TEST_TOPIC}`,
    SES_TEST_TOPIC.replace('123456789012', '210987654321'),
    'arn:aws:sns:us-east-1:666666666666:attacker',
    '',
  ),
  fc
    .stringMatching(/^arn:aws:sns:[a-z]{2}-[a-z]{4,9}-[1-3]:[0-9]{12}:[A-Za-z0-9_-]{1,40}$/)
    .filter((t) => t !== SES_TEST_TOPIC),
)

describe('AC-3: only an AWS-signed message for the store topic, with a certificate from SNS, verifies', () => {
  it('AC-3: each forgery of a signed Notification is not verified, and the real one is verified beside it', async () => {
    const net = stubFetch()
    await fc.assert(
      fc.asyncProperty(bounceFields, notificationForgery, async (f, { kind, forge }) => {
        const a = adapter()
        const unsigned = unsignedBounce(f)
        const real = signSns(unsigned)

        const forged = await receive(a, forge(unsigned, real))
        const genuine = await receive(a, snsRequest(real))

        expect([forged.verified, genuine.verified], kind).toEqual([false, true])
        expect(genuine.deliveryId).toBe(f.messageId)
      }),
      { numRuns: 300 },
    )
    expect(
      net.calls.filter((c) => !c.url.includes('.amazonaws.com/')).map((c) => c.url),
      'fetched a URL off SNS',
    ).toEqual([])
  })

  it('AC-3: a certificate URL on http, on another host (sns.evil.com, a suffix, userinfo @evil.com) or without .pem is refused without a fetch, where the same message on SNS’s URL verifies', async () => {
    await fc.assert(
      fc.asyncProperty(bounceFields, refusedCertUrl, async (f, certUrl) => {
        // Answers the certificate for any URL at all: only the adapter's URL rule can refuse.
        const net = stubFetch(() => certificateAnswer())
        const a = adapter()

        const refused = await receive(a, signedSnsPost(unsignedBounce(f, certUrl)))
        const fetchedForRefused = net.calls.map((c) => c.url)
        const genuine = await receive(a, signedSnsPost(unsignedBounce(f)))

        expect([refused.verified, genuine.verified], certUrl).toEqual([false, true])
        expect(fetchedForRefused, certUrl).toEqual([])
      }),
      { numRuns: 200 },
    )
  })

  it("AC-3: a message of any type for another topic, signed right, is not verified and fetches nothing, where the store's topic verifies", async () => {
    await fc.assert(
      fc.asyncProperty(anyType, otherTopic, fc.uuid(), async (type, topicArn, messageId) => {
        const net = stubFetch()
        const a = adapter()

        const foreign = await receive(a, signedSnsPost(messageOf(type, { topicArn, messageId })))
        const fetchedForForeign = net.calls.map((c) => c.url)
        const own = await receive(a, signedSnsPost(messageOf(type, { messageId })))

        expect([foreign.verified, own.verified], `${type} on "${topicArn}"`).toEqual([false, true])
        expect(fetchedForForeign, `${type} on "${topicArn}"`).toEqual([])
      }),
      { numRuns: 200 },
    )
  })

  it('AC-3: a store with no topicArn, or an empty one, verifies no message, even one whose TopicArn is empty too, and fetches nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        anyType,
        fc.constantFrom<string | null>(null, ''),
        fc.constantFrom(SES_TEST_TOPIC, ''),
        async (type, configured, topicArn) => {
          const net = stubFetch()
          const message = signedSnsPost(messageOf(type, { topicArn }))

          const without = await receive(adapter(configured), message)
          const fetchedWithout = net.calls.map((c) => c.url)
          const withTopic = await receive(adapter(topicArn || SES_TEST_TOPIC), message)

          expect(
            [without.verified, withTopic.verified],
            `${type} "${topicArn}" to a store with topicArn ${JSON.stringify(configured)}`,
          ).toEqual([false, topicArn !== ''])
          expect(fetchedWithout).toEqual([])
        },
      ),
    )
  })

  it('AC-3: a certificate URL whose body is not a certificate (text, an error page, a bare public key, a broken PEM) is not verified and not cached: the next message re-fetches it and verifies', async () => {
    const signer = sesTestSigner()
    const notACertificate = fc.constantFrom(
      'not a certificate',
      '',
      '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
      signer.publicKeyPem,
      '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
      signer.pem.slice(0, Math.floor(signer.pem.length / 2)),
    )
    await fc.assert(
      fc.asyncProperty(bounceFields, notACertificate, async (f, body) => {
        const certUrl = freshCertUrl()
        let served = 0
        const net = stubFetch((url) => {
          if (url !== certUrl) return snsAnswers(url)
          served += 1
          return served === 1 ? new Response(body, { status: 200 }) : certificateAnswer()
        })
        const a = adapter()
        const post = signedSnsPost(unsignedBounce(f, certUrl))

        const first = await receive(a, post)
        const second = await receive(a, post)

        expect([first.verified, second.verified], JSON.stringify(body.slice(0, 40))).toEqual([
          false,
          true,
        ])
        expect(net.callsTo(certUrl).length).toBe(served)
        expect(served).toBe(2)
      }),
    )
  })

  it("AC-3: a message of any type signed right under SignatureVersion 1 or 2, with a certificate on any region's SNS host (.amazonaws.com or .amazonaws.com.cn, in any case), verifies", async () => {
    stubFetch()
    const region = fc.constantFrom(
      'us-east-1',
      'eu-west-2',
      'ap-southeast-2',
      'us-gov-west-1',
      'cn-north-1',
      'me-central-1',
    )
    await fc.assert(
      fc.asyncProperty(
        anyType,
        fc.constantFrom('1', '2'),
        region,
        fc.boolean(),
        fc.boolean(),
        async (type, version, r, china, upper) => {
          const url = freshCertUrl(r, china)
          const certUrl = upper ? url.replace(/^https:\/\/[^/]+/, (h) => h.toUpperCase()) : url

          const delivery = await receive(
            adapter(),
            signedSnsPost(messageOf(type, { version, certUrl })),
          )

          expect(delivery.verified, `${type} v${version} at ${certUrl}`).toBe(true)
        },
      ),
    )
  })

  it("AC-3: a message signed with its fields in any order other than SNS's is not verified, where SNS's order verifies", async () => {
    stubFetch()
    await fc.assert(
      fc.asyncProperty(
        fc
          .constantFrom('Notification', 'SubscriptionConfirmation')
          .chain((type) =>
            fc.tuple(
              fc.constant(type),
              otherOrder(type === 'Notification' ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS),
            ),
          ),
        async ([type, order]) => {
          const unsigned = messageOf(type)
          expect(signedFields(unsigned).join()).not.toBe(order.join())

          const reordered = await receive(
            adapter(),
            snsRequest(signSns(unsigned, sesTestSigner().key, { order })),
          )
          const canonical = await receive(adapter(), snsRequest(signSns(unsigned)))

          expect([reordered.verified, canonical.verified], order.join(',')).toEqual([false, true])
        },
      ),
    )
  })

  it('AC-3: a certificate is fetched once per URL, also for messages received at once (Promise.all)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.integer({ min: 2, max: 5 }),
          fc.integer({ min: 0, max: 3 }),
          fc.integer({ min: 0, max: 3 }),
        ),
        fc.nat(),
        async (counts, seed) => {
          const urls = counts.map(() => freshCertUrl())
          const net = stubFetch(async (url) => {
            // Latency, so every receive is in flight before the first certificate arrives.
            await new Promise((resolve) => setTimeout(resolve, 10))
            return snsAnswers(url)
          })
          const a = adapter()
          const posts = urls.flatMap((url, i) =>
            Array.from({ length: counts[i]! }, () =>
              signedSnsPost(
                unsignedBounce({ messageId: snsMessageId(), to: 'x@ses.test', version: '2' }, url),
              ),
            ),
          )
          const shuffled = posts
            .map((post, i) => ({ post, key: (i * 7919 + seed) % 104_729 }))
            .sort((x, y) => x.key - y.key)
            .map((x) => x.post)

          const deliveries = await Promise.all(shuffled.map((post) => receive(a, post)))
          const later = await receive(a, posts[0]!)

          expect([...deliveries, later].map((d) => d.verified)).toEqual(
            [...shuffled, posts[0]].map(() => true),
          )
          expect(urls.map((url) => net.callsTo(url).length)).toEqual(
            counts.map((n) => (n > 0 ? 1 : 0)),
          )
        },
      ),
      { numRuns: 25 },
    )
  })

  it('AC-3: a certificate URL that redirects is not followed: the message is not verified and the redirect target is never fetched', async () => {
    const certUrl = freshCertUrl()
    const target = 'https://evil.example/stolen.pem'
    const net = redirectingFetch(certUrl, target, () => certificateAnswer())
    vi.stubGlobal('fetch', net.fetch)

    const delivery = await receive(
      adapter(),
      signedSnsPost(
        unsignedBounce({ messageId: 'redirected', to: 'r@ses.test', version: '2' }, certUrl),
      ),
    )

    expect([delivery.verified, net.callsTo(target).length]).toEqual([false, 0])
    expect(net.callsTo(certUrl).length).toBe(1)
  })

  it('AC-3: a certificate fetch that never answers is cut off by its time bound, and the message is not verified', async () => {
    const net = stubFetch((_url, call) => neverAnswers(call))
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('still waiting after 9 s'), 9_000)
    })

    const outcome = await Promise.race([
      receive(
        adapter(),
        signedSnsPost(
          unsignedBounce({ messageId: 'hangs', to: 'h@ses.test', version: '2' }, freshCertUrl()),
        ),
      ).then((d) => d.verified),
      deadline,
    ])
    clearTimeout(timer)

    expect(outcome).toBe(false)
    expect(net.calls.map((c) => c.signal?.aborted)).toEqual([true])
  }, 15_000)
})
