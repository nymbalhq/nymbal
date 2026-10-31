import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  shippingTrackingType,
  type ShippingTrackingStatus,
  type WebhookDelivery,
  type WebhookEventDraft,
  type WebhookHeaders,
} from '@nymbalhq/types'

export const EASYPOST_TRACKING = shippingTrackingType('easypost')

const SIGNATURE_HEADER = 'x-hmac-signature'
const SIGNATURE_PREFIX = 'hmac-sha256-hex='
const TRACKER_DESCRIPTIONS: ReadonlySet<unknown> = new Set(['tracker.created', 'tracker.updated'])

/** EasyPost's Tracker statuses onto the kernel's; a status not listed is `unknown`. */
const STATUSES: ReadonlyMap<unknown, ShippingTrackingStatus> = new Map<
  unknown,
  ShippingTrackingStatus
>([
  ['pre_transit', 'pre_transit'],
  ['in_transit', 'in_transit'],
  ['out_for_delivery', 'out_for_delivery'],
  ['available_for_pickup', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['return_to_sender', 'returned'],
  ['failure', 'exception'],
  ['error', 'exception'],
  ['cancelled', 'exception'],
  ['unknown', 'unknown'],
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

/** EasyPost keys the HMAC with the secret NFKD-normalised, as UTF-8, over the raw body; nothing else is signed. */
function signedWith(secret: string, rawBody: Buffer, header: string): boolean {
  if (!header.startsWith(SIGNATURE_PREFIX)) return false
  const key = Buffer.from(secret.normalize('NFKD'), 'utf8')
  const expected = Buffer.from(createHmac('sha256', key).update(rawBody).digest('hex'), 'utf8')
  const given = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * A Tracker Event's one tracking update. The tracking code is handed on as given: the kernel normalises it, and
 * refuses a delivery whose payload is malformed.
 */
function trackingOf(event: Json): WebhookEventDraft[] {
  const tracker = isObject(event['result']) ? event['result'] : {}
  const carrier = tracker['carrier']
  const updatedAt = tracker['updated_at']
  return [
    {
      type: EASYPOST_TRACKING,
      payload: {
        trackingNumber: tracker['tracking_code'],
        carrier: typeof carrier === 'string' ? carrier : null,
        status: STATUSES.get(tracker['status']) ?? 'unknown',
        occurredAt: typeof updatedAt === 'string' ? updatedAt : event['updated_at'],
      },
    },
  ]
}

/**
 * An EasyPost webhook post, verified. Its Event id is the delivery id, which EasyPost keeps on a retry, so the route's
 * claim dedupes it; since the whole body is signed, a replay is byte-identical and there is no timestamp to check.
 * An Event other than a Tracker's is verified with no events, so it is answered 200 and not retried.
 */
export function receiveEasyPostWebhook(
  secret: string | undefined,
  rawBody: Buffer,
  headers: WebhookHeaders,
): WebhookDelivery {
  const header = headers[SIGNATURE_HEADER]
  if (secret === undefined || typeof header !== 'string') return notVerified()
  if (!signedWith(secret, rawBody, header)) return notVerified()
  const event = parse(rawBody)
  const id = event?.['id']
  if (event === null || typeof id !== 'string' || id === '') return notVerified()
  const events = TRACKER_DESCRIPTIONS.has(event['description']) ? trackingOf(event) : []
  return { verified: true, deliveryId: id, events }
}
