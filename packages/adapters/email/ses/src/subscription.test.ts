import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailAdapter, Logger, WebhookDelivery } from '@nymbalhq/types'
import {
  CONFIRMATION_FIELDS,
  changeOneCharacter,
  confirmSubscriptionAnswer,
  fakeFetch,
  freshCertUrl,
  neverAnswers,
  redirectingFetch,
  SES_TEST_REGION,
  SES_TEST_TOPIC,
  sesOtherSigner,
  sesTestSigner,
  signedSnsPost,
  signSns,
  snsAnswers,
  snsRequest,
  subscribeUrlFor,
  subscriptionConfirmation,
  unsubscribeConfirmation,
  type FakeFetch,
  type FetchCall,
  type SesRequest,
  type SnsMessage,
  type UnsignedSnsMessage,
} from '../../../../../tests/support/ses'
import { createSesEmailAdapter, type SesEmailAdapterConfig } from './index.js'

// The store confirms its own SNS subscription: a signed SubscriptionConfirmation for its topic makes the adapter GET
// the message's SubscribeURL, once, on SNS's host only. `fetch` is a fake (vi.stubGlobal) that answers SNS's
// confirmation for a SubscribeURL and the test certificate for any other URL, and records every call.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(
  answer: (url: string, call: FetchCall) => Response | Promise<Response> = snsAnswers,
): FakeFetch {
  const net = fakeFetch(answer)
  vi.stubGlobal('fetch', net.fetch)
  return net
}

function adapter(): EmailAdapter {
  return createSesEmailAdapter({
    logger,
    config: {
      from: 'store@ses.test',
      region: SES_TEST_REGION,
      smtp: { host: '127.0.0.1', port: 1, user: 'AKIASESTESTUSER', pass: 'ses-smtp-password' },
      topicArn: SES_TEST_TOPIC,
    } as SesEmailAdapterConfig,
  })
}

async function receive(a: EmailAdapter, request: SesRequest): Promise<WebhookDelivery> {
  expect(typeof a.receiveWebhook, 'the adapter has no receiveWebhook').toBe('function')
  return a.receiveWebhook!(request.rawBody, request.headers)
}

/** The URLs fetched other than `certUrl`: what the adapter called beyond the certificate. */
const beyond = (net: FakeFetch, certUrl: string): string[] =>
  net.calls.filter((c) => c.url !== certUrl).map((c) => c.url)

/** Settles once the adapter's outbound call to `url` has settled, however it awaits it. */
async function settledCall(net: FakeFetch, url: string): Promise<void> {
  await vi.waitFor(() => expect(net.callsTo(url).length).toBeGreaterThan(0), {
    timeout: 2_000,
    interval: 5,
  })
}

const confirmationFields = fc.record({
  messageId: fc.uuid(),
  token: fc.stringMatching(/^[0-9a-f]{64,128}$/),
  version: fc.constantFrom('1', '2'),
  region: fc.constantFrom('us-east-1', 'eu-west-1', 'ap-northeast-1', 'cn-northwest-1'),
})
type Fields = typeof confirmationFields extends fc.Arbitrary<infer T> ? T : never

/** A confirmation for the store's topic under `f`, on a fresh certificate URL, unsigned. */
function confirmationOf(f: Fields, subscribeUrl?: string): UnsignedSnsMessage {
  return subscriptionConfirmation({
    messageId: f.messageId,
    token: f.token,
    version: f.version,
    certUrl: freshCertUrl(f.region),
    subscribeUrl: subscribeUrl ?? subscribeUrlFor(SES_TEST_TOPIC, f.token, f.region),
  })
}

/** A SubscribeURL the adapter must never GET: not https, or not on SNS's host by `new URL(u).hostname`. */
const refusedSubscribeUrl = fc.constantFrom(
  `http://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${SES_TEST_TOPIC}&Token=t`,
  `ftp://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t`,
  'https://sns.evil.com/?Action=ConfirmSubscription&Token=t',
  'https://sns.us-east-1.amazonaws.com.evil.com/?Action=ConfirmSubscription&Token=t',
  'https://sns.us-east-1.amazonaws.com@evil.com/?Action=ConfirmSubscription&Token=t',
  'https://evil.com/?Action=ConfirmSubscription&next=https://sns.us-east-1.amazonaws.com/',
  'https://evil.sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
  'https://sns.s3.amazonaws.com/confirm?Action=ConfirmSubscription&Token=t',
  'https://169.254.169.254/latest/meta-data/?Action=ConfirmSubscription',
  'https://localhost:3000/api/admin?Action=ConfirmSubscription',
  'not a url?Action=ConfirmSubscription',
)

/** A forgery of a signed confirmation, made from the unsigned message and its correct signing. */
type Forge = (unsigned: UnsignedSnsMessage, real: SnsMessage) => SesRequest

const forgedConfirmation: fc.Arbitrary<{ kind: string; forge: Forge }> = fc.oneof(
  fc.tuple(fc.constantFrom(...CONFIRMATION_FIELDS), fc.nat()).map(([name, at]) => ({
    kind: `${name} changed after signing`,
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) =>
      snsRequest({
        ...real,
        [name]: changeOneCharacter(String((real as unknown as Record<string, unknown>)[name]), at),
      }),
  })),
  fc.constant({
    kind: "SubscribeURL swapped after signing for another on SNS's host",
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) =>
      snsRequest({
        ...real,
        SubscribeURL: subscribeUrlFor('arn:aws:sns:us-east-1:666666666666:attacker', 'swapped'),
      }),
  }),
  fc.constant({
    kind: 'signed with another key',
    forge: (unsigned: UnsignedSnsMessage) => snsRequest(signSns(unsigned, sesOtherSigner().key)),
  }),
  fc.constant({
    kind: 'SignatureVersion 3',
    forge: (unsigned: UnsignedSnsMessage) =>
      snsRequest(
        signSns({ ...unsigned, SignatureVersion: '3' }, sesTestSigner().key, { hash: 'sha256' }),
      ),
  }),
  fc.nat().map((at) => ({
    kind: 'a character of Signature changed',
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) =>
      snsRequest({ ...real, Signature: changeOneCharacter(real.Signature, at % 300) }),
  })),
  fc.constant({
    kind: 'Token removed after signing',
    forge: (_u: UnsignedSnsMessage, real: SnsMessage) => {
      const { Token: _dropped, ...rest } = real
      return snsRequest(rest)
    },
  }),
)

describe('AC-4: the store confirms its own subscription, and only that', () => {
  it('AC-4: a signed SubscriptionConfirmation for the store topic GETs its SubscribeURL once and gives events: []', async () => {
    await fc.assert(
      fc.asyncProperty(confirmationFields, async (f) => {
        const net = stubFetch()
        const message = confirmationOf(f)

        const delivery = await receive(adapter(), signedSnsPost(message))
        await settledCall(net, message.SubscribeURL!)

        expect([delivery.verified, delivery.events]).toEqual([true, []])
        expect(net.callsTo(message.SubscribeURL!).map((c) => c.method)).toEqual(['GET'])
        expect(beyond(net, message.SigningCertURL)).toEqual([message.SubscribeURL])
      }),
    )
  })

  it("AC-4: a signed confirmation whose SubscribeURL is not https on SNS's host is not fetched, where the same confirmation on SNS's URL is", async () => {
    await fc.assert(
      fc.asyncProperty(confirmationFields, refusedSubscribeUrl, async (f, subscribeUrl) => {
        const net = stubFetch((url) =>
          url.includes('ConfirmSubscription') ? confirmSubscriptionAnswer() : snsAnswers(url),
        )
        const refused = confirmationOf(f, subscribeUrl)
        const allowed = confirmationOf(f)

        await receive(adapter(), signedSnsPost(refused))
        await receive(adapter(), signedSnsPost(allowed))
        await settledCall(net, allowed.SubscribeURL!)
        const certificates = [refused.SigningCertURL, allowed.SigningCertURL]

        expect(
          net.calls.map((c) => c.url).filter((url) => !certificates.includes(url)),
          subscribeUrl,
        ).toEqual([allowed.SubscribeURL])
      }),
      { numRuns: 100 },
    )
  })

  it('AC-4: a forged SubscriptionConfirmation is not verified and fetches nothing but the certificate, where the real one is verified and GETs its SubscribeURL', async () => {
    await fc.assert(
      fc.asyncProperty(confirmationFields, forgedConfirmation, async (f, { kind, forge }) => {
        const net = stubFetch()
        const unsigned = confirmationOf(f)
        const real = signSns(unsigned)
        const a = adapter()

        const forged = await receive(a, forge(unsigned, real))
        const fetchedForForged = beyond(net, unsigned.SigningCertURL)
        const genuine = await receive(a, snsRequest(real))
        await settledCall(net, unsigned.SubscribeURL!)

        expect([forged.verified, genuine.verified], kind).toEqual([false, true])
        expect(fetchedForForged, kind).toEqual([])
        expect(beyond(net, unsigned.SigningCertURL)).toEqual([unsigned.SubscribeURL])
      }),
      { numRuns: 200 },
    )
  })

  it('AC-4: a SubscriptionConfirmation for another topic, signed right, is not verified and GETs nothing, not even the certificate', async () => {
    const otherTopic = fc.oneof(
      fc.constantFrom(
        'arn:aws:sns:us-east-1:666666666666:attacker',
        `${SES_TEST_TOPIC}-other`,
        SES_TEST_TOPIC.replace('123456789012', '123456789013'),
      ),
      fc
        .stringMatching(/^arn:aws:sns:[a-z]{2}-[a-z]{4,9}-[1-3]:[0-9]{12}:[A-Za-z0-9_-]{1,40}$/)
        .filter((t) => t !== SES_TEST_TOPIC),
    )
    await fc.assert(
      fc.asyncProperty(confirmationFields, otherTopic, async (f, topicArn) => {
        const net = stubFetch()
        const foreign = subscriptionConfirmation({
          messageId: f.messageId,
          token: f.token,
          version: f.version,
          topicArn,
          certUrl: freshCertUrl(f.region),
          subscribeUrl: subscribeUrlFor(topicArn, f.token, f.region),
        })
        const own = confirmationOf(f)

        const refused = await receive(adapter(), signedSnsPost(foreign))
        const accepted = await receive(adapter(), signedSnsPost(own))
        await settledCall(net, own.SubscribeURL!)
        const ownCalls = [own.SigningCertURL, own.SubscribeURL]

        expect([refused.verified, accepted.verified], topicArn).toEqual([false, true])
        expect(
          net.calls.map((c) => c.url).filter((url) => !ownCalls.includes(url)),
          topicArn,
        ).toEqual([])
      }),
    )
  })

  it('AC-4: a signed UnsubscribeConfirmation is verified with no events and GETs nothing beyond the certificate, though it carries a SubscribeURL', async () => {
    await fc.assert(
      fc.asyncProperty(confirmationFields, async (f) => {
        const net = stubFetch()
        // Its own token, so its SubscribeURL is not the later confirmation's.
        const token = `${f.token}0`
        const unsubscribed = unsubscribeConfirmation({
          messageId: f.messageId,
          token,
          version: f.version,
          certUrl: freshCertUrl(f.region),
          subscribeUrl: subscribeUrlFor(SES_TEST_TOPIC, token, f.region),
        })
        const subscribed = confirmationOf(f)
        const a = adapter()

        const delivery = await receive(a, signedSnsPost(unsubscribed))
        // A later confirmation's GET is the marker that any outbound call the first one started has been made.
        await receive(a, signedSnsPost(subscribed))
        await settledCall(net, subscribed.SubscribeURL!)

        expect([delivery.verified, delivery.events]).toEqual([true, []])
        expect(net.callsTo(unsubscribed.SubscribeURL!)).toEqual([])
        expect(net.callsTo(subscribed.SubscribeURL!).length).toBe(1)
      }),
    )
  })

  it('AC-4: a SubscribeURL that redirects is not followed: the redirect target is never fetched', async () => {
    const message = confirmationOf({
      messageId: 'redirects',
      token: 'a'.repeat(64),
      version: '2',
      region: 'us-east-1',
    })
    const target = 'https://evil.example/collect'
    const net = redirectingFetch(message.SubscribeURL!, target, (url) =>
      url === target ? confirmSubscriptionAnswer() : snsAnswers(url),
    )
    vi.stubGlobal('fetch', net.fetch)

    await receive(adapter(), signedSnsPost(message))
    await settledCall(net, message.SubscribeURL!)

    expect(net.callsTo(target)).toEqual([])
    expect(net.callsTo(message.SubscribeURL!).length).toBe(1)
  })

  it('AC-4: a SubscribeURL GET that never answers is cut off by its time bound', async () => {
    const message = confirmationOf({
      messageId: 'hangs',
      token: 'b'.repeat(64),
      version: '2',
      region: 'us-east-1',
    })
    const net = stubFetch((url, call) =>
      url === message.SubscribeURL ? neverAnswers(call) : snsAnswers(url),
    )

    const pending = receive(adapter(), signedSnsPost(message)).catch(() => undefined)
    await settledCall(net, message.SubscribeURL!)
    const [get] = net.callsTo(message.SubscribeURL!)

    await vi.waitFor(() => expect(get!.signal?.aborted, 'the GET was never cut off').toBe(true), {
      timeout: 9_000,
      interval: 50,
    })
    await pending
    expect(net.callsTo(message.SubscribeURL!).length).toBe(1)
  }, 15_000)
})
