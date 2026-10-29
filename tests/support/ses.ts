import {
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'

export { changeOneCharacter } from './mailgun'

// Amazon SES feedback as SNS posts it: a JSON envelope sent as `text/plain`, its `Type` also in the
// `x-amz-sns-message-type` header. SNS signs the envelope's fields in a fixed order, each as `Name\nValue\n`, with
// SHA1withRSA (`SignatureVersion` 1) or SHA256withRSA (2), under the certificate at `SigningCertURL`. A Notification
// signs Message, MessageId, Subject (when present), Timestamp, TopicArn and Type; a confirmation signs Message,
// MessageId, SubscribeURL, Timestamp, Token, TopicArn and Type (aws/aws-js-sns-message-validator). The certificate here
// is self-signed, built with node:crypto alone, so nothing reaches the network.

// --- a self-signed X.509 certificate, DER by hand -------------------------------------------------------------------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const der = (tag: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
const sequence = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts))
const setOf = (...parts: Buffer[]): Buffer => der(0x31, Buffer.concat(parts))
const integer = (bytes: Buffer): Buffer =>
  der(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes)
const NULL = Buffer.from([0x05, 0x00])
function objectId(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const out = [a! * 40 + b!]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let v = arc >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return der(0x06, Buffer.from(out))
}
const utcTime = (at: Date): Buffer =>
  der(0x17, Buffer.from(`${at.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`, 'ascii'))

/** A key and its self-signed certificate (PEM), as SNS's `SigningCertURL` would answer it. */
export interface TestSigner {
  key: KeyObject
  /** The certificate, PEM. */
  pem: string
  /** The bare public key, PEM: a body that is a key but no certificate. */
  publicKeyPem: string
}

/** A fresh RSA key and a self-signed certificate for it. Throws (a setup error) if the certificate does not parse. */
export function selfSignedSigner(commonName = 'sns.amazonaws.com'): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const algorithm = sequence(objectId('1.2.840.113549.1.1.11'), NULL)
  const name = sequence(setOf(sequence(objectId('2.5.4.3'), der(0x0c, Buffer.from(commonName)))))
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([1]), randomBytes(7)])),
    algorithm,
    name,
    sequence(utcTime(new Date('2020-01-01T00:00:00Z')), utcTime(new Date('2049-12-31T23:59:59Z'))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  )
  const certificate = sequence(
    tbs,
    algorithm,
    der(0x03, Buffer.concat([Buffer.from([0]), signBytes('sha256', tbs, privateKey)])),
  )
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? []
  const pem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
  new X509Certificate(pem)
  return {
    key: privateKey,
    pem,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

let testSigner: TestSigner | undefined
let otherSigner: TestSigner | undefined
/** The tests' SNS signer: the key messages are signed with, and the certificate the fake fetch answers. */
export function sesTestSigner(): TestSigner {
  testSigner ??= selfSignedSigner()
  return testSigner
}
/** A second key and certificate, never the one a store is shown for a message. */
export function sesOtherSigner(): TestSigner {
  otherSigner ??= selfSignedSigner('sns.other.test')
  return otherSigner
}

// --- SNS messages ---------------------------------------------------------------------------------------------------

export const SES_TEST_REGION = 'us-east-1'
/** The topic the tests' stores are configured with. */
export const SES_TEST_TOPIC = 'arn:aws:sns:us-east-1:123456789012:nymbal-ses-feedback'
/** The certificate URL of the tests' messages unless a case gives another. */
export const SES_TEST_CERT_URL =
  'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000000000000000000000000000test.pem'

/** A certificate URL on SNS's host for `region` (`.amazonaws.com`, or `.amazonaws.com.cn` when `china`), unique. */
export function freshCertUrl(region = SES_TEST_REGION, china = false): string {
  return `https://sns.${region}.amazonaws.com${china ? '.cn' : ''}/SimpleNotificationService-${randomBytes(16).toString('hex')}.pem`
}

export const NOTIFICATION_FIELDS = [
  'Message',
  'MessageId',
  'Subject',
  'Timestamp',
  'TopicArn',
  'Type',
] as const
export const CONFIRMATION_FIELDS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
] as const

/** An SNS envelope. A field a case leaves out is left out of the post. */
export interface SnsMessage {
  Type: string
  MessageId: string
  TopicArn: string
  Subject?: string
  Message: string
  Timestamp: string
  SignatureVersion: string
  Signature: string
  SigningCertURL: string
  SubscribeURL?: string
  Token?: string
  UnsubscribeURL?: string
}
export type UnsignedSnsMessage = Omit<SnsMessage, 'Signature'>

/** The fields signed for `message`'s type, in SNS's order. */
export function signedFields(message: Pick<SnsMessage, 'Type'>): readonly string[] {
  return message.Type === 'Notification' ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS
}

/** The string SNS signs: each field present, in `order` (SNS's for the type by default), as `Name\nValue\n`. */
export function canonicalString(
  message: UnsignedSnsMessage,
  order: readonly string[] = signedFields(message),
): string {
  const fields = message as unknown as Record<string, string | undefined>
  return order
    .filter((name) => fields[name] !== undefined)
    .map((name) => `${name}\n${fields[name]}\n`)
    .join('')
}

export interface SignSnsOptions {
  /** The field order to sign in; SNS's for the type by default. */
  order?: readonly string[]
  /** The hash; the one `SignatureVersion` names by default (1 SHA1, otherwise SHA256). */
  hash?: 'sha1' | 'sha256'
}

/** `message` with SNS's signature over it, by `key` (the tests' signer's by default). */
export function signSns(
  message: UnsignedSnsMessage,
  key: KeyObject = sesTestSigner().key,
  opts: SignSnsOptions = {},
): SnsMessage {
  const hash = opts.hash ?? (message.SignatureVersion === '1' ? 'sha1' : 'sha256')
  const signature = signBytes(hash, Buffer.from(canonicalString(message, opts.order), 'utf8'), key)
  return { ...message, Signature: signature.toString('base64') }
}

export interface EnvelopeOptions {
  messageId?: string
  topicArn?: string
  /** `SignatureVersion`, `2` by default. */
  version?: string
  certUrl?: string
  /** SNS's own `Timestamp`, when it posted the message. */
  timestamp?: string
}

let ids = 0
/** An SNS message id, unique in the process. */
export function snsMessageId(): string {
  ids += 1
  const hex = randomBytes(16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${ids.toString(16).padStart(12, '0')}`
}

function envelope(type: string, message: string, opts: EnvelopeOptions): UnsignedSnsMessage {
  return {
    Type: type,
    MessageId: opts.messageId ?? snsMessageId(),
    TopicArn: opts.topicArn ?? SES_TEST_TOPIC,
    Message: message,
    Timestamp: opts.timestamp ?? new Date().toISOString(),
    SignatureVersion: opts.version ?? '2',
    SigningCertURL: opts.certUrl ?? SES_TEST_CERT_URL,
  }
}

export const SES_SUBJECT = 'Amazon SES Email Event Notification'

/** A Notification carrying `ses` (an SES message), unsigned. `subject: null` leaves `Subject` out. */
export function notification(
  ses: object,
  opts: EnvelopeOptions & { subject?: string | null } = {},
): UnsignedSnsMessage {
  const base = envelope('Notification', JSON.stringify(ses), opts)
  const topic = base.TopicArn
  return {
    ...base,
    ...(opts.subject !== null && { Subject: opts.subject ?? SES_SUBJECT }),
    UnsubscribeURL: `https://sns.${SES_TEST_REGION}.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${topic}:0000`,
  }
}

/** SNS's `SubscribeURL` for `topic` and `token`. */
export const subscribeUrlFor = (topic: string, token: string, region = SES_TEST_REGION): string =>
  `https://sns.${region}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=${token}`

function confirmation(
  type: 'SubscriptionConfirmation' | 'UnsubscribeConfirmation',
  opts: EnvelopeOptions & { token?: string; subscribeUrl?: string },
): UnsignedSnsMessage {
  const topic = opts.topicArn ?? SES_TEST_TOPIC
  const token = opts.token ?? randomBytes(32).toString('hex')
  const verb = type === 'SubscriptionConfirmation' ? 'subscribe to' : 'unsubscribe from'
  return {
    ...envelope(
      type,
      `You have chosen to ${verb} the topic ${topic}.\nTo confirm the subscription, visit the SubscribeURL included in this message.`,
      opts,
    ),
    SubscribeURL: opts.subscribeUrl ?? subscribeUrlFor(topic, token),
    Token: token,
  }
}

/** A SubscriptionConfirmation, unsigned. */
export const subscriptionConfirmation = (
  opts: EnvelopeOptions & { token?: string; subscribeUrl?: string } = {},
): UnsignedSnsMessage => confirmation('SubscriptionConfirmation', opts)

/** An UnsubscribeConfirmation, unsigned: it carries a `SubscribeURL` too, to subscribe again. */
export const unsubscribeConfirmation = (
  opts: EnvelopeOptions & { token?: string; subscribeUrl?: string } = {},
): UnsignedSnsMessage => confirmation('UnsubscribeConfirmation', opts)

/** A webhook request: the exact bytes and the headers, as the kernel's route hands them to `receiveWebhook`. */
export interface SesRequest {
  rawBody: Buffer
  headers: Record<string, string>
}

/** `message` as SNS posts it: pretty-printed JSON as `text/plain`, with SNS's headers. */
export function snsRequest(message: SnsMessage | Record<string, unknown>): SesRequest {
  const m = message as Record<string, unknown>
  return {
    rawBody: Buffer.from(JSON.stringify(message, null, 2), 'utf8'),
    headers: {
      'content-type': 'text/plain; charset=UTF-8',
      'x-amz-sns-message-type': String(m['Type']),
      'x-amz-sns-message-id': String(m['MessageId']),
      'x-amz-sns-topic-arn': String(m['TopicArn']),
      'user-agent': 'Amazon Simple Notification Service Agent',
    },
  }
}

/** A signed post of `message` by the tests' signer. */
export const signedSnsPost = (message: UnsignedSnsMessage): SesRequest =>
  snsRequest(signSns(message))

// --- SES messages (the Notification's `Message`) --------------------------------------------------------------------

/** Where SES names the kind: identity notifications use `notificationType`, configuration-set events `eventType`. */
export type KindField = 'notificationType' | 'eventType'

export interface SesOptions {
  kindField?: KindField
  /** `mail.messageId`, SES's id for the sent email. */
  mailMessageId?: string
  /** `mail.timestamp`, when the email was sent: never the feedback's time. */
  mailTimestamp?: string
  /** The bounce's or complaint's `timestamp`. */
  at?: string
}

export interface SesMessage {
  notificationType?: string
  eventType?: string
  mail?: { messageId: string; timestamp: string; [field: string]: unknown }
  bounce?: {
    bounceType: string
    bouncedRecipients: { emailAddress: string; [field: string]: unknown }[]
    timestamp: string
    feedbackId: string
    [field: string]: unknown
  }
  complaint?: {
    complainedRecipients: { emailAddress: string }[]
    timestamp: string
    feedbackId: string
    [field: string]: unknown
  }
  [field: string]: unknown
}

function sesMessage(
  kind: string,
  recipients: string[],
  extra: object,
  opts: SesOptions,
): SesMessage {
  const at = opts.at ?? new Date().toISOString()
  return {
    [opts.kindField ?? 'notificationType']: kind,
    ...extra,
    mail: {
      timestamp: opts.mailTimestamp ?? new Date(Date.parse(at) - 60_000).toISOString(),
      source: 'store@ses.test',
      sourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/ses.test',
      sendingAccountId: '123456789012',
      messageId: opts.mailMessageId ?? `0100${randomBytes(12).toString('hex')}-000000`,
      destination: recipients,
    },
  }
}

/** A bounce of `bounceType` (`Permanent`, `Transient`, `Undetermined`) to `recipients`. */
export function sesBounce(
  recipients: string[],
  bounceType: string,
  opts: SesOptions = {},
): SesMessage {
  const at = opts.at ?? new Date().toISOString()
  return sesMessage(
    'Bounce',
    recipients,
    {
      bounce: {
        feedbackId: `0100${randomBytes(12).toString('hex')}-000000`,
        bounceType,
        bounceSubType: bounceType === 'Permanent' ? 'General' : 'MailboxFull',
        bouncedRecipients: recipients.map((emailAddress) => ({
          emailAddress,
          action: 'failed',
          status: '5.1.1',
          diagnosticCode: 'smtp; 550 5.1.1 user unknown',
        })),
        timestamp: at,
        reportingMTA: 'dsn; a8-70.smtp-out.amazonses.com',
      },
    },
    { ...opts, at },
  )
}

/** A spam complaint from `recipients`. */
export function sesComplaint(recipients: string[], opts: SesOptions = {}): SesMessage {
  const at = opts.at ?? new Date().toISOString()
  return sesMessage(
    'Complaint',
    recipients,
    {
      complaint: {
        feedbackId: `0100${randomBytes(12).toString('hex')}-000000`,
        complainedRecipients: recipients.map((emailAddress) => ({ emailAddress })),
        complaintFeedbackType: 'abuse',
        timestamp: at,
        userAgent: 'ExampleCorp Feedback Loop (V0.01)',
      },
    },
    { ...opts, at },
  )
}

/** Any other kind SES publishes to the same topic (`Delivery` by default), to `recipients`. */
export function sesOther(kind: string, recipients: string[], opts: SesOptions = {}): SesMessage {
  const at = opts.at ?? new Date().toISOString()
  return sesMessage(
    kind,
    recipients,
    {
      delivery: {
        timestamp: at,
        processingTimeMillis: 546,
        recipients,
        smtpResponse: '250 ok',
        reportingMTA: 'a8-70.smtp-out.amazonses.com',
      },
    },
    { ...opts, at },
  )
}

// --- a fake fetch ---------------------------------------------------------------------------------------------------

export interface FetchCall {
  url: string
  /** The method, upper case: `GET` unless the call named another. */
  method: string
  /** The redirect mode the call asked for: `follow`, fetch's default, unless it named another. */
  redirect: RequestRedirect
  signal: AbortSignal | undefined
}

export interface FakeFetch {
  fetch: typeof fetch
  calls: FetchCall[]
  /** The calls to `url`. */
  callsTo(url: string): FetchCall[]
}

/** The URL `input` names, whatever form `fetch` was given it in. */
export const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

/** A `fetch` that records every call and answers with `answer`; it never reaches the network. */
export function fakeFetch(
  answer: (url: string, call: FetchCall) => Response | Promise<Response>,
): FakeFetch {
  const calls: FetchCall[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined
    const call: FetchCall = {
      url: urlOf(input),
      method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
      redirect: init?.redirect ?? request?.redirect ?? 'follow',
      signal: init?.signal ?? request?.signal ?? undefined,
    }
    calls.push(call)
    return answer(call.url, call)
  }
  return {
    fetch: fn as typeof fetch,
    calls,
    callsTo: (url) => calls.filter((c) => c.url === url),
  }
}

/**
 * `answer`, except that `from` answers a 302 to `to` as fetch would take it: refused under `redirect: 'error'`, handed
 * back under `manual`, and followed (a recorded call to `to`) otherwise.
 */
export function redirectingFetch(
  from: string,
  to: string,
  answer: (url: string, call: FetchCall) => Response | Promise<Response>,
): FakeFetch {
  const net: FakeFetch = fakeFetch((url, call) => {
    if (url !== from) return answer(url, call)
    if (call.redirect === 'error') throw new TypeError(`fetch failed: ${from} redirected`)
    if (call.redirect === 'manual') {
      return new Response(null, { status: 302, headers: { location: to } })
    }
    return net.fetch(to, { method: call.method, ...(call.signal && { signal: call.signal }) })
  })
  return net
}

/** A response that never comes: it rejects only when the call's signal aborts. */
export function neverAnswers(call: FetchCall): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true })
  })
}

/** SNS's answer to a GET of a `SubscribeURL`. */
export const confirmSubscriptionAnswer = (): Response =>
  new Response(
    '<ConfirmSubscriptionResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><ConfirmSubscriptionResult><SubscriptionArn>arn:aws:sns:us-east-1:123456789012:nymbal-ses-feedback:0000</SubscriptionArn></ConfirmSubscriptionResult></ConfirmSubscriptionResponse>',
    { status: 200, headers: { 'content-type': 'text/xml' } },
  )

/** A certificate body, as SNS answers its `SigningCertURL`. */
export const certificateAnswer = (pem: string = sesTestSigner().pem): Response =>
  new Response(pem, { status: 200, headers: { 'content-type': 'application/x-x509-ca-cert' } })

/** In a certificate URL, marks one whose body is the other signer's certificate. */
export const OTHER_CERT_MARK = 'other-signer'

/**
 * SNS as the tests' fake sees it: a `SubscribeURL` (`Action=ConfirmSubscription`) answers the confirmation, and every
 * other URL, on any host, answers a certificate: the other signer's when the URL carries `OTHER_CERT_MARK`, else the
 * tests' signer's. So a URL rule, not the fake, is what keeps an adapter from verifying against a URL it should refuse.
 */
export function snsAnswers(url: string): Response {
  if (url.includes('Action=ConfirmSubscription')) return confirmSubscriptionAnswer()
  return certificateAnswer(
    url.includes(OTHER_CERT_MARK) ? sesOtherSigner().pem : sesTestSigner().pem,
  )
}
