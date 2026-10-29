import { createHmac, randomBytes } from 'node:crypto'

// Mailgun's webhooks as Mailgun sends them: a JSON body `{ signature: { timestamp, token, signature }, "event-data" }`
// where `signature` is hex HMAC-SHA256, keyed with the domain's webhook signing key, over `timestamp` then `token`,
// the strings as sent. Nothing else is signed: `event-data` is not bound to its signature. Each builder below gives a
// post with a fresh token, as Mailgun gives each post its own.

/** The signing key the tests' Mailgun adapters and the custom-providers store are configured with. */
export const MAILGUN_TEST_SIGNING_KEY = 'mailgun-test-signing-key-0123456789abcdef'

export interface MailgunSignatureFields {
  timestamp: string
  token: string
}

export interface MailgunSignature extends MailgunSignatureFields {
  signature: string
}

/** One Mailgun event as `event-data` carries it. Fields a case leaves out are left out of the post. */
export interface MailgunEventData {
  id: string
  event: string
  severity?: string
  recipient: string
  /** Epoch seconds, with a fraction. */
  timestamp: number
  message?: { headers: { 'message-id'?: string } }
  reason?: string
  [field: string]: unknown
}

export interface MailgunPostBody {
  signature?: Partial<Record<keyof MailgunSignature, unknown>>
  'event-data'?: unknown
  [field: string]: unknown
}

/** A webhook request: the exact bytes and the headers, as the kernel's route hands them to `receiveWebhook`. */
export interface MailgunRequest {
  rawBody: Buffer
  headers: Record<string, string>
}

/** `signature` for the `timestamp` and `token` strings as given, with `key`. */
export function signMailgun(fields: MailgunSignatureFields, key: string): MailgunSignature {
  const signature = createHmac('sha256', key)
    .update(fields.timestamp + fields.token)
    .digest('hex')
  return { timestamp: fields.timestamp, token: fields.token, signature }
}

/** A token of Mailgun's shape: 50 hex characters, never given out twice. */
export function freshToken(): string {
  return randomBytes(25).toString('hex')
}

/** Now as Mailgun writes `signature.timestamp`: whole epoch seconds, as a string. */
export function nowSeconds(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds)
}

/** Any body as a JSON post. */
export function mailgunRequest(body: unknown): MailgunRequest {
  return {
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    headers: { 'content-type': 'application/json' },
  }
}

export interface SignOptions {
  key?: string
  /** `signature.timestamp`; now by default. */
  timestamp?: string
  /** `signature.token`; a fresh one by default. */
  token?: string
}

/** The body of a signed post of `eventData`. */
export function signedBody(eventData: unknown, opts: SignOptions = {}): MailgunPostBody {
  const signature = signMailgun(
    { timestamp: opts.timestamp ?? nowSeconds(), token: opts.token ?? freshToken() },
    opts.key ?? MAILGUN_TEST_SIGNING_KEY,
  )
  return { signature, 'event-data': eventData }
}

/** A signed post of `eventData`, as a request. */
export function signedPost(eventData: unknown, opts: SignOptions = {}): MailgunRequest {
  return mailgunRequest(signedBody(eventData, opts))
}

let ids = 0
/** An event id of Mailgun's shape, unique in the process. */
export function eventId(): string {
  ids += 1
  return `${randomBytes(8).toString('hex')}-${ids}`
}

interface EventOptions {
  id?: string
  messageId?: string | null
  /** Epoch seconds, fractional. */
  timestamp?: number
}

function event(
  recipient: string,
  fields: Partial<MailgunEventData>,
  opts: EventOptions,
): MailgunEventData {
  const id = opts.id ?? eventId()
  // From the id, so one event built twice (Mailgun's retry of it) is the same event.
  const messageId = opts.messageId === undefined ? `${id}@mg.nymbal.test` : opts.messageId
  return {
    id,
    event: 'delivered',
    recipient,
    timestamp: opts.timestamp ?? Date.now() / 1000,
    ...(messageId !== null && { message: { headers: { 'message-id': messageId } } }),
    ...fields,
  }
}

/** A permanent failure: the mailbox does not exist. */
export const permanentFailure = (recipient: string, opts: EventOptions = {}): MailgunEventData =>
  event(recipient, { event: 'failed', severity: 'permanent', reason: 'bounce' }, opts)

/** A temporary failure: the mailbox is full, or the host deferred. */
export const temporaryFailure = (recipient: string, opts: EventOptions = {}): MailgunEventData =>
  event(recipient, { event: 'failed', severity: 'temporary', reason: 'generic' }, opts)

/** A spam complaint. */
export const complaint = (recipient: string, opts: EventOptions = {}): MailgunEventData =>
  event(recipient, { event: 'complained' }, opts)

/** A delivery, which a merchant may subscribe to the same URL. */
export const delivered = (recipient: string, opts: EventOptions = {}): MailgunEventData =>
  event(recipient, { event: 'delivered' }, opts)

/** `text` with the character at `at` (taken modulo its length) replaced by another. */
export function changeOneCharacter(text: string, at: number): string {
  if (text === '') return 'x'
  const i = at % text.length
  const was = text[i]!
  const now = was === '0' ? '1' : was === 'a' ? 'b' : /[0-9]/.test(was) ? '0' : 'a'
  return `${text.slice(0, i)}${now}${text.slice(i + 1)}`
}
