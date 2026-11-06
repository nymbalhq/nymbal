import { createHmac, randomBytes } from 'node:crypto'

// AfterShip Tracking's webhooks (API 2026-07) as AfterShip sends them: a JSON body `{ event, event_id,
// is_tracking_first_tag, msg, ts }` whose `event` is `tracking_update`, `edd_revise` or `tracking_pending_time`, whose
// `msg` is the Tracking (`id, tracking_number, slug, tag, subtag, updated_at, …`) and whose `ts` is UNIX seconds. The
// header `aftership-hmac-sha256` is the standard base64 of HMAC-SHA256 over the raw body, keyed with the webhook secret
// as UTF-8 text; nothing else is signed. The header, encoding and key are AfterShip's webhook-signature page as read on
// 2026-11-05 (its sample: createHmac('sha256', secret).update(data).digest('base64')); the body's shape is from
// Hookdeck's reference (hookdeck/webhook-skills 0aa8c48, skills/aftership-webhooks/references) and the official SDK's
// Tracking model (AfterShip/tracking-sdk-nodejs 2026-07 at f3ec2eb). A request carries the exact bytes that were
// signed, never an object re-serialised after signing.

/** The webhook secret the tests' AfterShip adapters are configured with. */
export const AFTERSHIP_TEST_WEBHOOK_SECRET = 'aftership-test-webhook-secret-0123456789abcdef'

/** The header AfterShip signs in, as Node hands it to the route (lower case). */
export const AFTERSHIP_SIGNATURE_HEADER = 'aftership-hmac-sha256'

/** Every `msg.tag` AfterShip reports. */
export const AFTERSHIP_TAGS = [
  'Pending',
  'InfoReceived',
  'InTransit',
  'OutForDelivery',
  'AttemptFail',
  'Delivered',
  'AvailableForPickup',
  'Exception',
  'Expired',
] as const

export type AfterShipTag = (typeof AFTERSHIP_TAGS)[number]

/** The webhook events AfterShip's Tracking product posts. */
export const AFTERSHIP_EVENTS = ['tracking_update', 'edd_revise', 'tracking_pending_time'] as const

/** One Tracking as `msg` carries it. Fields a case leaves out are left out of the post. */
export interface AfterShipTracking {
  id: string
  tracking_number: string
  slug?: string | null
  tag: string
  subtag?: string
  updated_at?: string
  [field: string]: unknown
}

/** One webhook body as AfterShip posts it. */
export interface AfterShipWebhook {
  event: string
  event_id: string
  is_tracking_first_tag: boolean
  msg: unknown
  ts: number
  [field: string]: unknown
}

/** A webhook request: the exact bytes and the headers, as the kernel's route hands them to `receiveWebhook`. */
export interface AfterShipRequest {
  rawBody: Buffer
  headers: Record<string, string>
}

/** The header value AfterShip sends for `rawBody` under `secret`: base64 HMAC-SHA256, the secret as UTF-8. */
export function signAfterShip(rawBody: Buffer | string, secret: string): string {
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(bytes).digest('base64')
}

/** `rawBody` as a request, with `signature` as the header value, or no signature header when it is null. */
export function aftershipRequest(
  rawBody: Buffer | string,
  signature: string | null,
): AfterShipRequest {
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
  return {
    rawBody: bytes,
    headers: {
      'content-type': 'application/json',
      ...(signature !== null && { [AFTERSHIP_SIGNATURE_HEADER]: signature }),
    },
  }
}

/** The body's JSON, the bytes AfterShip would sign and post. */
export function webhookBody(body: unknown): string {
  return JSON.stringify(body)
}

/** A signed post of `body`, with the tests' secret unless another is given. */
export function signedPost(
  body: unknown,
  secret: string = AFTERSHIP_TEST_WEBHOOK_SECRET,
): AfterShipRequest {
  const raw = webhookBody(body)
  return aftershipRequest(raw, signAfterShip(raw, secret))
}

let ids = 0
/** An event id of a UUID's shape, unique in the process. */
export function eventId(): string {
  ids += 1
  const h = randomBytes(10).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${String(ids).padStart(12, '0')}`
}

/** A time as AfterShip writes `updated_at`: ISO 8601 with an offset, whole seconds. */
export function aftershipTime(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

export interface UpdateOptions {
  /** The body's `event_id`; a fresh one by default. Building one update twice with the same id is AfterShip's retry. */
  id?: string
  event?: string
  /** `msg.slug`; `usps` by default, absent when null. */
  slug?: string | null
  /** `msg.updated_at`; the update's time by default, absent when null, or any string a case wants. */
  updatedAt?: string | null
  /** The time of the update: `ts` is its UNIX seconds. Now by default. */
  at?: Date
}

/** A `tracking_update` (unless another event is given) for `trackingNumber` at `tag`. */
export function trackingUpdate(
  trackingNumber: string,
  tag: string,
  opts: UpdateOptions = {},
): AfterShipWebhook {
  const at = opts.at ?? new Date()
  const id = opts.id ?? eventId()
  const msg: AfterShipTracking = {
    // From the event id, so one update built twice is the same bytes.
    id: `trk${id.replace(/-/g, '').slice(0, 24)}`,
    tracking_number: trackingNumber,
    tag,
    subtag: `${tag}_001`,
    ...(opts.slug !== null && { slug: opts.slug ?? 'usps' }),
    ...(opts.updatedAt !== null && { updated_at: opts.updatedAt ?? aftershipTime(at) }),
  }
  return {
    event: opts.event ?? 'tracking_update',
    event_id: id,
    is_tracking_first_tag: false,
    msg,
    ts: Math.floor(at.getTime() / 1000),
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
