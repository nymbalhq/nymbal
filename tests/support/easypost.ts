import { createHmac, randomBytes } from 'node:crypto'

// EasyPost's webhooks as EasyPost sends them: a JSON Event `{ id: 'evt_…', object: 'Event', description, mode,
// result, … }` whose `result`, for trackers, is a Tracker `{ id: 'trk_…', tracking_code, carrier, status, updated_at,
// … }`. With a webhook secret set, the header `x-hmac-signature` is `hmac-sha256-hex=<hex>`: HMAC-SHA256 over the raw
// body, keyed with the secret NFKD-normalised, as UTF-8. Nothing else is signed: no timestamp, no path. A request
// carries the exact bytes that were signed, never an object re-serialised after signing.

/** The webhook secret the tests' EasyPost adapters and the custom-providers store are configured with. */
export const EASYPOST_TEST_WEBHOOK_SECRET = 'easypost-test-webhook-secret-0123456789abcdef'

/** The header EasyPost signs in, as Node hands it to the route (lower case). */
export const EASYPOST_SIGNATURE_HEADER = 'x-hmac-signature'

/** What the header's value starts with. */
export const EASYPOST_SIGNATURE_PREFIX = 'hmac-sha256-hex='

/** Every status an EasyPost Tracker reports. */
export const EASYPOST_TRACKER_STATUSES = [
  'unknown',
  'pre_transit',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'available_for_pickup',
  'return_to_sender',
  'failure',
  'cancelled',
  'error',
] as const

export type EasyPostTrackerStatus = (typeof EASYPOST_TRACKER_STATUSES)[number]

/** The two Event descriptions that carry a Tracker. */
export const EASYPOST_TRACKER_DESCRIPTIONS = ['tracker.created', 'tracker.updated'] as const

/** One Tracker as an Event's `result` carries it. Fields a case leaves out are left out of the post. */
export interface EasyPostTracker {
  id: string
  object: 'Tracker'
  mode: 'test' | 'production'
  tracking_code: string
  carrier?: string | null
  status: string
  updated_at?: string
  created_at?: string
  [field: string]: unknown
}

/** One Event as EasyPost posts it. */
export interface EasyPostEvent {
  id: string
  object: 'Event'
  description: string
  mode: 'test' | 'production'
  result: unknown
  created_at?: string
  updated_at?: string
  [field: string]: unknown
}

/** A webhook request: the exact bytes and the headers, as the kernel's route hands them to `receiveWebhook`. */
export interface EasyPostRequest {
  rawBody: Buffer
  headers: Record<string, string>
}

/** The header value EasyPost sends for `rawBody` under `secret`: `hmac-sha256-hex=<hex>`. */
export function signEasyPost(rawBody: Buffer | string, secret: string): string {
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
  const key = Buffer.from(secret.normalize('NFKD'), 'utf8')
  return `${EASYPOST_SIGNATURE_PREFIX}${createHmac('sha256', key).update(bytes).digest('hex')}`
}

/** `rawBody` as a request, with `signature` as the header value, or no signature header when it is null. */
export function easypostRequest(
  rawBody: Buffer | string,
  signature: string | null,
): EasyPostRequest {
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
  return {
    rawBody: bytes,
    headers: {
      'content-type': 'application/json',
      ...(signature !== null && { [EASYPOST_SIGNATURE_HEADER]: signature }),
    },
  }
}

/** The Event's JSON, the bytes EasyPost would sign and post. */
export function eventBody(event: unknown): string {
  return JSON.stringify(event)
}

/** A signed post of `event`, with the tests' secret unless another is given. */
export function signedPost(
  event: unknown,
  secret: string = EASYPOST_TEST_WEBHOOK_SECRET,
): EasyPostRequest {
  const body = eventBody(event)
  return easypostRequest(body, signEasyPost(body, secret))
}

let ids = 0
function id(prefix: string): string {
  ids += 1
  return `${prefix}_${randomBytes(12).toString('hex')}${ids}`
}

/** An Event id of EasyPost's shape, unique in the process. */
export const eventId = (): string => id('evt')
/** A Tracker id of EasyPost's shape, unique in the process. */
export const trackerId = (): string => id('trk')

/** A time as EasyPost writes it: ISO 8601 in UTC, whole seconds. */
export function easypostTime(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface TrackerOptions {
  /** The Event's id; a fresh one by default. Building one event twice with the same id is EasyPost's retry of it. */
  id?: string
  description?: (typeof EASYPOST_TRACKER_DESCRIPTIONS)[number]
  carrier?: string | null
  /** The Tracker's `updated_at`; now by default. */
  at?: Date
}

/** An Event of a Tracker for `trackingCode` reporting `status`: `tracker.updated` unless another kind is given. */
export function trackerEvent(
  trackingCode: string,
  status: EasyPostTrackerStatus,
  opts: TrackerOptions = {},
): EasyPostEvent {
  const at = easypostTime(opts.at ?? new Date())
  const eventIdGiven = opts.id ?? eventId()
  return {
    id: eventIdGiven,
    object: 'Event',
    description: opts.description ?? 'tracker.updated',
    mode: 'test',
    created_at: at,
    updated_at: at,
    // From the event id, so one event built twice is the same bytes.
    result: {
      id: `trk_${eventIdGiven.replace(/^evt_/, '')}`,
      object: 'Tracker',
      mode: 'test',
      tracking_code: trackingCode,
      carrier: opts.carrier === undefined ? 'USPS' : opts.carrier,
      status,
      created_at: at,
      updated_at: at,
    } satisfies EasyPostTracker,
  }
}

/** An Event that is not a Tracker's: a batch, a refund, a scan form, an invoice. */
export function otherEvent(description: string, opts: { id?: string } = {}): EasyPostEvent {
  const at = easypostTime(new Date())
  return {
    id: opts.id ?? eventId(),
    object: 'Event',
    description,
    mode: 'test',
    created_at: at,
    updated_at: at,
    result: { id: 'batch_0123456789abcdef', object: 'Batch', state: 'purchased' },
  }
}

/** `bytes` with the byte at `at` (taken modulo the length) changed to another. */
export function changeOneByte(bytes: Buffer, at: number): Buffer {
  const out = Buffer.from(bytes)
  if (out.length === 0) return Buffer.from('x')
  const i = at % out.length
  out[i] = out[i]! ^ 0x01
  return out
}
