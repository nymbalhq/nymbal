import { createHmac, randomBytes } from 'node:crypto'

export { changeOneCharacter } from './mailgun'

// Resend's webhooks as Resend sends them, through Svix: a JSON body `{ type, created_at, data }` and three headers,
// `svix-id`, `svix-timestamp` (epoch seconds) and `svix-signature`, a space-separated list of `<version>,<base64>`
// entries. A `v1` entry is base64 HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`, the body's exact bytes,
// keyed with the bytes the secret's base64 decodes to (after `whsec_`, when the secret carries it). A retry keeps its
// `svix-id` and is signed again with a new timestamp.

/** The key bytes of the tests' webhook secret. */
export const RESEND_TEST_KEY = Buffer.from('nymbal-resend-test-key-0123456789', 'utf8')

/** The webhook secret the tests' Resend adapters are configured with, as Resend's dashboard shows it. */
export const RESEND_TEST_SECRET = `whsec_${RESEND_TEST_KEY.toString('base64')}`

/** The base64 key bytes of a `whsec_…` secret, or of a bare base64 one. */
function keyOf(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64')
}

/** The base64 v1 signature of `body` under `id` and `timestamp`, with `secret` (`whsec_…` or bare base64). */
export function signSvix(
  id: string,
  timestamp: string,
  body: string | Buffer,
  secret: string,
): string {
  return createHmac('sha256', keyOf(secret))
    .update(`${id}.${timestamp}.`)
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest('base64')
}

/** A webhook request: the exact bytes and the headers, as the kernel's route hands them to `receiveWebhook`. */
export interface ResendRequest {
  rawBody: Buffer
  headers: Record<string, string>
}

/** Now as Svix writes `svix-timestamp`: whole epoch seconds, as a string. */
export function nowSeconds(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds)
}

let ids = 0
/** A message id of Svix's shape, unique in the process. */
export function svixId(): string {
  ids += 1
  return `msg_${randomBytes(9).toString('hex')}${ids}`
}

export interface SignOptions {
  /** `svix-id`; a fresh one by default. */
  id?: string
  /** `svix-timestamp`; now by default. */
  timestamp?: string
  secret?: string
  /** The `svix-signature` header from the right base64 signature; `v1,<signature>` by default. */
  signatureHeader?: (signature: string) => string
}

/** `rawBody`'s bytes as Svix posts them, signed. */
export function signedBytes(rawBody: Buffer, opts: SignOptions = {}): ResendRequest {
  const id = opts.id ?? svixId()
  const timestamp = opts.timestamp ?? nowSeconds()
  const signature = signSvix(id, timestamp, rawBody, opts.secret ?? RESEND_TEST_SECRET)
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': (opts.signatureHeader ?? ((s) => `v1,${s}`))(signature),
    },
  }
}

/** A signed post of `payload`, as JSON. */
export function signedPost(payload: unknown, opts: SignOptions = {}): ResendRequest {
  return signedBytes(Buffer.from(JSON.stringify(payload), 'utf8'), opts)
}

/** One Resend webhook payload. Fields a case leaves out are left out of the post. */
export interface ResendEvent {
  type: string
  /** When Resend recorded the event: ISO 8601. */
  created_at: string
  data: {
    email_id: string
    to: string[]
    /** When the email itself was created, in Resend's database format: never the event's time. */
    created_at: string
    from?: string
    subject?: string
    bounce?: { type?: string; subType?: string; message?: string }
    [field: string]: unknown
  }
}

export interface EventOptions {
  emailId?: string
  /** The top-level `created_at`, the event's time; now by default. */
  createdAt?: Date
  /** `data.created_at`, the email's; a minute before the event by default. */
  emailCreatedAt?: Date
}

/** `at` as Resend writes `data.created_at`: microseconds and `+00:00`. */
export function databaseTime(at: Date): string {
  return at.toISOString().replace('Z', '000+00:00')
}

function event(type: string, to: string[], extra: object, opts: EventOptions): ResendEvent {
  const createdAt = opts.createdAt ?? new Date()
  const emailCreatedAt = opts.emailCreatedAt ?? new Date(createdAt.getTime() - 60_000)
  return {
    type,
    created_at: createdAt.toISOString(),
    data: {
      email_id: opts.emailId ?? randomBytes(16).toString('hex'),
      from: 'Store <store@resend.test>',
      to,
      subject: 'Back in stock',
      created_at: databaseTime(emailCreatedAt),
      ...extra,
    },
  }
}

/** A bounce of `bounceType` (`Permanent`, `Transient`, `Undetermined`, …); `null` leaves `bounce.type` out. */
export const bounced = (
  to: string[],
  bounceType: string | null,
  opts: EventOptions = {},
): ResendEvent =>
  event(
    'email.bounced',
    to,
    {
      bounce: {
        ...(bounceType !== null && { type: bounceType }),
        subType: 'General',
        message: 'The recipient mail server rejected the message.',
      },
    },
    opts,
  )

/** A spam complaint. */
export const complained = (to: string[], opts: EventOptions = {}): ResendEvent =>
  event('email.complained', to, {}, opts)

/** Any other event Resend sends to the same endpoint, `email.delivered` by default. */
export const other = (
  to: string[],
  type = 'email.delivered',
  opts: EventOptions = {},
): ResendEvent => event(type, to, {}, opts)
