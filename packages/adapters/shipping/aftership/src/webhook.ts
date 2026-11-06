import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  shippingTrackingType,
  type ShippingTrackingStatus,
  type WebhookDelivery,
  type WebhookEventDraft,
  type WebhookHeaders,
} from '@nymbalhq/types'

export const AFTERSHIP_TRACKING = shippingTrackingType('aftership')

const SIGNATURE_HEADER = 'aftership-hmac-sha256'

/** AfterShip's tracking tags onto the kernel's statuses; a tag not listed is `unknown`. Only Delivered delivers. */
const STATUSES: ReadonlyMap<unknown, ShippingTrackingStatus> = new Map<
  unknown,
  ShippingTrackingStatus
>([
  ['Pending', 'pre_transit'],
  ['InfoReceived', 'pre_transit'],
  ['InTransit', 'in_transit'],
  ['OutForDelivery', 'out_for_delivery'],
  ['AvailableForPickup', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['AttemptFail', 'exception'],
  ['Exception', 'exception'],
  ['Expired', 'unknown'],
])

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function notVerified(): WebhookDelivery {
  return { verified: false, deliveryId: '', events: [] }
}

function parse(rawBody: Buffer): Json | null {
  try {
    const body: unknown = JSON.parse(rawBody.toString('utf8'))
    return isObject(body) ? body : null
  } catch {
    return null
  }
}

/** AfterShip signs the raw body: base64 of HMAC-SHA256, keyed with the webhook secret as UTF-8 text. */
function signedWith(secret: string, rawBody: Buffer, header: string): boolean {
  const expected = Buffer.from(
    createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest('base64'),
    'utf8',
  )
  const given = Buffer.from(header, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** `msg.updated_at` when it reads as a date, else the post's `ts` (UNIX seconds), as ISO 8601. */
function occurredAt(msg: Json, ts: unknown): unknown {
  const updated = msg['updated_at']
  const at = typeof updated === 'string' ? Date.parse(updated) : Number.NaN
  if (!Number.isNaN(at)) return new Date(at).toISOString()
  return typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : ts
}

/**
 * A tracking_update's one tracking update. The tracking number is handed on as given: the kernel normalises it, and
 * refuses a delivery whose payload is malformed.
 */
function trackingOf(body: Json): WebhookEventDraft[] {
  const msg = isObject(body['msg']) ? body['msg'] : {}
  const slug = msg['slug']
  return [
    {
      type: AFTERSHIP_TRACKING,
      payload: {
        trackingNumber: msg['tracking_number'],
        carrier: typeof slug === 'string' ? slug : null,
        status: STATUSES.get(msg['tag']) ?? 'unknown',
        occurredAt: occurredAt(msg, body['ts']),
      },
    },
  ]
}

/**
 * An AfterShip webhook post, verified. Its `event_id` is the delivery id, kept on AfterShip's retries, so the route's
 * claim dedupes it; the whole body is signed, so a replay is byte-identical. An event other than `tracking_update` is
 * verified with no events, so it is answered 200 and not retried.
 */
export function receiveAfterShipWebhook(
  secret: string | undefined,
  rawBody: Buffer,
  headers: WebhookHeaders,
): WebhookDelivery {
  const header = headers[SIGNATURE_HEADER]
  if (secret === undefined || typeof header !== 'string') return notVerified()
  if (!signedWith(secret, rawBody, header)) return notVerified()
  const body = parse(rawBody)
  const id = body?.['event_id']
  if (body === null || typeof id !== 'string' || id === '') return notVerified()
  const events = body['event'] === 'tracking_update' ? trackingOf(body) : []
  return { verified: true, deliveryId: id, events }
}
