import { verify, X509Certificate } from 'node:crypto'
import {
  emailFeedbackType,
  errorText,
  type Logger,
  type WebhookDelivery,
  type WebhookEventDraft,
} from '@nymbalhq/types'

export const SES_BOUNCED = emailFeedbackType('ses', 'bounced')
export const SES_COMPLAINED = emailFeedbackType('ses', 'complained')

/** Both outbound calls (the certificate, the SubscribeURL) are cut off after this. */
const FETCH_TIMEOUT_MS = 5_000
/** A body this size or larger is no SNS certificate, and is never parsed or cached. */
const MAX_CERTIFICATE_BYTES = 64 * 1024
/** Certificate URLs come from the post, so the cache is bounded: the oldest entry goes first. */
const MAX_CACHED_CERTIFICATES = 8

/**
 * SNS's own hosts, by `new URL(u).hostname`, in every region including China's. The label must be region-shaped:
 * `sns.s3.amazonaws.com` is an S3 bucket anyone may own, and would serve their certificate.
 */
const SNS_HOST = /^sns\.[a-z]{2}(-[a-z]+)+-\d+\.amazonaws\.com(\.cn)?$/

/** The fields SNS signs, in its order, per message type (aws/aws-js-sns-message-validator). */
const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
const CONFIRMATION_FIELDS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
]
const SIGNED_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Notification', NOTIFICATION_FIELDS],
  ['SubscriptionConfirmation', CONFIRMATION_FIELDS],
  ['UnsubscribeConfirmation', CONFIRMATION_FIELDS],
])
/** `SignatureVersion` 1 is SHA1withRSA, 2 SHA256withRSA. */
const HASHES: ReadonlyMap<string, string> = new Map([
  ['1', 'sha1'],
  ['2', 'sha256'],
])

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function notVerified(): WebhookDelivery {
  return { verified: false, deliveryId: '', events: [] }
}

function parse(text: string): Json | null {
  try {
    const body: unknown = JSON.parse(text)
    return isObject(body) ? body : null
  } catch {
    return null
  }
}

/** An `https:` URL on an SNS host, by its parsed hostname, never by its text. */
function onSnsHost(text: string): URL | undefined {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  return url.protocol === 'https:' && SNS_HOST.test(url.hostname) ? url : undefined
}

/** `url` fetched with no redirect followed and a time bound; `fetch` is resolved when it runs, not at import. */
function boundedFetch(url: string): Promise<Response> {
  return globalThis.fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

/** An unread body is cancelled so its socket is released; a body that will not cancel changes nothing here. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined)
}

/** The default certificate fetch: the body of `url` as text, refused unless it answered 2xx. */
export async function fetchCertificateText(url: string): Promise<string> {
  const res = await boundedFetch(url)
  if (!res.ok) {
    await discard(res)
    throw new Error(`certificate fetch answered ${res.status}`)
  }
  return res.text()
}

/**
 * The certificates by URL. Only a body that parses as an X.509 certificate is kept, so an error page or a timeout is
 * fetched again next time; concurrent receives of one URL share its fetch.
 */
function certificateCache(
  fetchCertificate: (url: string) => Promise<string>,
  log: Logger,
): (url: string) => Promise<X509Certificate | undefined> {
  const cached = new Map<string, X509Certificate>()
  const inFlight = new Map<string, Promise<X509Certificate | undefined>>()

  async function load(url: string): Promise<X509Certificate | undefined> {
    let text: unknown
    try {
      text = await fetchCertificate(url)
    } catch (err) {
      log.warn({ url, err: errorText(err) }, 'SNS certificate fetch failed; the post is refused')
      return undefined
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') >= MAX_CERTIFICATE_BYTES) {
      log.warn({ url }, 'SNS certificate URL answered no certificate; the post is refused')
      return undefined
    }
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(text)
    } catch {
      log.warn({ url }, 'SNS certificate URL answered no certificate; the post is refused')
      return undefined
    }
    if (cached.size >= MAX_CACHED_CERTIFICATES) {
      const oldest = cached.keys().next().value
      if (oldest !== undefined) cached.delete(oldest)
    }
    cached.set(url, certificate)
    return certificate
  }

  return (url) => {
    const hit = cached.get(url)
    if (hit !== undefined) return Promise.resolve(hit)
    const pending = inFlight.get(url)
    if (pending !== undefined) return pending
    const started = load(url).finally(() => inFlight.delete(url))
    inFlight.set(url, started)
    return started
  }
}

/** The signed fields as strings, or null when one SNS always sends is missing or not a string. */
function signedValues(message: Json, fields: readonly string[]): Map<string, string> | null {
  const values = new Map<string, string>()
  for (const name of fields) {
    const value = message[name]
    if (value === undefined && name === 'Subject') continue
    if (typeof value !== 'string') return null
    values.set(name, value)
  }
  return values
}

/** SNS's string to sign: each field present, in order, as `Name\nValue\n`. */
function canonicalString(values: Map<string, string>): string {
  let out = ''
  for (const [name, value] of values) out += `${name}\n${value}\n`
  return out
}

/** The feedback's own time as ISO 8601; null leaves the kernel to refuse the event. */
function occurredAtOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

function recipientsOf(list: unknown): unknown[] {
  return Array.isArray(list)
    ? list.map((entry: unknown) => (isObject(entry) ? entry['emailAddress'] : entry))
    : []
}

/**
 * An SES message: a `Permanent` bounce is hard and any other bounce soft, one event per bounced recipient; a
 * complaint is one event per complained recipient. Identity notifications name the kind in `notificationType`,
 * configuration-set events in `eventType`. Any other kind (`Delivery`, SES's subscription test) carries none.
 */
function eventsOf(text: string): WebhookEventDraft[] {
  const ses = parse(text)
  if (ses === null) return []
  const kind = ses['notificationType'] ?? ses['eventType']
  const mail = ses['mail']
  const messageId = isObject(mail) && typeof mail['messageId'] === 'string' ? mail['messageId'] : null
  if (kind === 'Bounce' && isObject(ses['bounce'])) {
    const bounce = ses['bounce']
    const hardness = bounce['bounceType'] === 'Permanent' ? 'hard' : 'soft'
    const occurredAt = occurredAtOf(bounce['timestamp'])
    return recipientsOf(bounce['bouncedRecipients']).map((recipient) => ({
      type: SES_BOUNCED,
      payload: { recipient, bounce: hardness, messageId, occurredAt },
    }))
  }
  if (kind === 'Complaint' && isObject(ses['complaint'])) {
    const complaint = ses['complaint']
    const occurredAt = occurredAtOf(complaint['timestamp'])
    return recipientsOf(complaint['complainedRecipients']).map((recipient) => ({
      type: SES_COMPLAINED,
      payload: { recipient, messageId, occurredAt },
    }))
  }
  return []
}

export interface SnsReceiverDeps {
  /** The configured topic; anything but a non-empty string refuses every post. */
  topicArn: () => string | undefined
  fetchCertificate: (url: string) => Promise<string>
  log: Logger
}

/**
 * SNS posts of SES feedback. A valid AWS signature proves only that some AWS account published the message, so the
 * configured topic is checked first, before anything is fetched. Then the certificate URL must be SNS's, and the
 * signature must verify against it. A signed SubscriptionConfirmation for the topic is confirmed by a GET of its
 * SubscribeURL, on SNS's host only. A replay is byte-identical, and the route's claim on `MessageId` dedupes it.
 */
export function createSnsWebhookReceiver(
  deps: SnsReceiverDeps,
): (rawBody: Buffer) => Promise<WebhookDelivery> {
  const certificate = certificateCache(deps.fetchCertificate, deps.log)

  async function confirm(subscribeUrl: string, topicArn: string): Promise<void> {
    if (onSnsHost(subscribeUrl) === undefined) {
      deps.log.warn({ topicArn }, 'SNS SubscribeURL is not on an SNS host; subscription not confirmed')
      return
    }
    try {
      const res = await boundedFetch(subscribeUrl)
      if (res.ok) deps.log.info({ topicArn }, 'SNS subscription confirmed')
      else {
        await discard(res)
        deps.log.warn({ topicArn, status: res.status }, 'SNS subscription confirmation refused')
      }
    } catch (err) {
      deps.log.warn({ topicArn, err: errorText(err) }, 'SNS subscription confirmation failed')
    }
  }

  return async (rawBody) => {
    const message = parse(rawBody.toString('utf8'))
    if (message === null) return notVerified()
    const version = message['SignatureVersion']
    const hash = typeof version === 'string' ? HASHES.get(version) : undefined
    if (hash === undefined) return notVerified()
    const type = message['Type']
    const fields = typeof type === 'string' ? SIGNED_FIELDS.get(type) : undefined
    if (fields === undefined) return notVerified()
    const values = signedValues(message, fields)
    if (values === null) return notVerified()

    const topicArn = deps.topicArn()
    if (topicArn === undefined || topicArn === '' || values.get('TopicArn') !== topicArn) {
      return notVerified()
    }

    const certUrl = message['SigningCertURL']
    const signature = message['Signature']
    if (typeof certUrl !== 'string' || typeof signature !== 'string' || signature === '') {
      return notVerified()
    }
    if (!onSnsHost(certUrl)?.pathname.endsWith('.pem')) return notVerified()
    const cert = await certificate(certUrl)
    if (cert === undefined) return notVerified()
    let signed: boolean
    try {
      signed = verify(
        hash,
        Buffer.from(canonicalString(values), 'utf8'),
        cert.publicKey,
        Buffer.from(signature, 'base64'),
      )
    } catch {
      // A key that cannot take this hash or signature throws: the post simply does not verify.
      signed = false
    }
    if (!signed) return notVerified()

    const deliveryId = values.get('MessageId')!
    if (type === 'SubscriptionConfirmation') {
      await confirm(values.get('SubscribeURL')!, topicArn)
      return { verified: true, deliveryId, events: [] }
    }
    if (type === 'UnsubscribeConfirmation') {
      deps.log.warn({ topicArn }, 'SNS unsubscribed this store from the topic: SES feedback stops')
      return { verified: true, deliveryId, events: [] }
    }
    return { verified: true, deliveryId, events: eventsOf(values.get('Message')!) }
  }
}
