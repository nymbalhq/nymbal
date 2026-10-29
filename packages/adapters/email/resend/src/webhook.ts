import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  emailFeedbackType,
  type WebhookDelivery,
  type WebhookEventDraft,
  type WebhookHeaders,
} from '@nymbalhq/types'

export const RESEND_BOUNCED = emailFeedbackType('resend', 'bounced')
export const RESEND_COMPLAINED = emailFeedbackType('resend', 'complained')

/** How far `svix-timestamp` may be from now, either way: Svix's own tolerance. */
const WINDOW_SECONDS = 300
const SECRET_PREFIX = 'whsec_'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function notVerified(): WebhookDelivery {
  return { verified: false, deliveryId: '', events: [] }
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The HMAC key: the base64 after `whsec_`, as Resend's dashboard shows the secret, or a bare base64 secret. A secret
 * that decodes to no bytes (`whsec_` alone, text that is not base64) is no key: an empty one lets anyone sign.
 */
export function signingKey(secret: string): Buffer | undefined {
  const key = Buffer.from(
    secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret,
    'base64',
  )
  return key.length > 0 ? key : undefined
}

/** Whether any `v1,<base64>` entry of the space-separated `svix-signature` is the HMAC of `id.timestamp.body`. */
function signedWith(
  key: Buffer,
  id: string,
  timestamp: string,
  rawBody: Buffer,
  signatures: string,
): boolean {
  const expected = Buffer.from(
    createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest('base64'),
    'utf8',
  )
  let matched = false
  for (const entry of signatures.split(' ')) {
    const comma = entry.indexOf(',')
    if (comma === -1 || entry.slice(0, comma) !== 'v1') continue
    const given = Buffer.from(entry.slice(comma + 1), 'utf8')
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true
  }
  return matched
}

function parse(rawBody: Buffer): Json | null {
  try {
    const body: unknown = JSON.parse(rawBody.toString('utf8'))
    return isObject(body) ? body : null
  } catch {
    return null
  }
}

/** The top-level `created_at`, when Resend recorded the event, as ISO 8601; null leaves the kernel to refuse it. */
function occurredAtOf(body: Json): string | null {
  const createdAt = body['created_at']
  if (typeof createdAt !== 'string') return null
  const at = new Date(createdAt)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/**
 * A `Permanent` bounce, in any casing, is hard and any other bounce soft; one event per `data.to` address. Types
 * other than bounces and complaints carry none. Recipients are handed on as given: the kernel normalises them, and
 * refuses a delivery whose payload is malformed.
 */
function eventsOf(body: Json): WebhookEventDraft[] {
  const data = body['data']
  if (!isObject(data)) return []
  const to: unknown[] = Array.isArray(data['to']) ? (data['to'] as unknown[]) : [data['to']]
  const messageId = typeof data['email_id'] === 'string' ? data['email_id'] : null
  const occurredAt = occurredAtOf(body)
  if (body['type'] === 'email.bounced') {
    const bounceType = isObject(data['bounce']) ? data['bounce']['type'] : undefined
    const bounce =
      typeof bounceType === 'string' && bounceType.toLowerCase() === 'permanent' ? 'hard' : 'soft'
    return to.map((recipient) => ({
      type: RESEND_BOUNCED,
      payload: { recipient, bounce, messageId, occurredAt },
    }))
  }
  if (body['type'] === 'email.complained') {
    return to.map((recipient) => ({
      type: RESEND_COMPLAINED,
      payload: { recipient, messageId, occurredAt },
    }))
  }
  return []
}

/**
 * Resend's webhook posts, verified as Svix signs them. The signature covers the id, the timestamp and the body, so a
 * captured post replays only byte for byte, and the route's claim on `svix-id` dedupes that.
 */
export function createResendWebhookReceiver(
  secret: () => string | undefined,
): (rawBody: Buffer, headers: WebhookHeaders) => Promise<WebhookDelivery> {
  return async (rawBody, headers) => {
    const configured = secret()
    const key = configured === undefined ? undefined : signingKey(configured)
    const id = header(headers, 'svix-id')
    const timestamp = header(headers, 'svix-timestamp')
    const signatures = header(headers, 'svix-signature')
    if (
      key === undefined ||
      id === undefined ||
      timestamp === undefined ||
      signatures === undefined
    ) {
      return notVerified()
    }
    if (!signedWith(key, id, timestamp, rawBody, signatures)) return notVerified()
    const signedAt = Number(timestamp)
    if (!Number.isFinite(signedAt) || Math.abs(Date.now() / 1000 - signedAt) > WINDOW_SECONDS) {
      return notVerified()
    }
    const body = parse(rawBody)
    if (body === null) return notVerified()

    return { verified: true, deliveryId: id, events: eventsOf(body) }
  }
}
