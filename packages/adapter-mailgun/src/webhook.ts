import { createHmac, timingSafeEqual } from 'node:crypto'
import { emailFeedbackType, type WebhookDelivery, type WebhookEventDraft } from '@nymbalhq/types'

export const MAILGUN_BOUNCED = emailFeedbackType('mailgun', 'bounced')
export const MAILGUN_COMPLAINED = emailFeedbackType('mailgun', 'complained')

/** How far `signature.timestamp` may be from now, either way. */
const WINDOW_SECONDS = 300

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

/** Mailgun's HMAC is over `timestamp` then `token`, the strings as posted; `event-data` is not signed. */
function signedWith(key: string, timestamp: string, token: string, signature: string): boolean {
  const expected = Buffer.from(
    createHmac('sha256', key).update(timestamp).update(token).digest('hex'),
    'utf8',
  )
  const given = Buffer.from(signature, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function messageIdOf(data: Json): string | null {
  const message = data['message']
  const headers = isObject(message) ? message['headers'] : undefined
  const id = isObject(headers) ? headers['message-id'] : undefined
  return typeof id === 'string' ? id : null
}

/** `event-data.timestamp`, epoch seconds with a fraction, as ISO 8601; null leaves the kernel to refuse it. */
function occurredAtOf(data: Json): string | null {
  const seconds = data['timestamp']
  if (typeof seconds !== 'number') return null
  const at = new Date(seconds * 1000)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/**
 * A permanent failure is a hard bounce and any other failure soft; events other than failures and complaints carry
 * none. The recipient is handed on as given: the kernel normalises it, and refuses a delivery whose payload is malformed.
 */
function eventsOf(data: Json): WebhookEventDraft[] {
  const recipient = data['recipient']
  const messageId = messageIdOf(data)
  const occurredAt = occurredAtOf(data)
  if (data['event'] === 'failed') {
    const bounce = data['severity'] === 'permanent' ? 'hard' : 'soft'
    return [{ type: MAILGUN_BOUNCED, payload: { recipient, bounce, messageId, occurredAt } }]
  }
  if (data['event'] === 'complained') {
    return [{ type: MAILGUN_COMPLAINED, payload: { recipient, messageId, occurredAt } }]
  }
  return []
}

/**
 * Mailgun's webhook posts, verified. Since the body is unsigned, one captured signature would carry any `event-data`
 * while its timestamp is fresh, so each accepted token is bound to its event id until the timestamp leaves the window:
 * the same token with the same id is Mailgun's retry, with another id a forgery. The binding is per process.
 */
export function createMailgunWebhookReceiver(
  signingKey: () => string | undefined,
): (rawBody: Buffer) => Promise<WebhookDelivery> {
  const tokens = new Map<string, { eventId: string; expiresAt: number }>()

  return async (rawBody) => {
    const now = Date.now()
    for (const [token, entry] of tokens) {
      if (entry.expiresAt < now) tokens.delete(token)
    }

    const key = signingKey()
    const body = parse(rawBody)
    const signature = body?.['signature']
    const data = body?.['event-data']
    if (key === undefined || !isObject(signature) || !isObject(data)) return notVerified()
    const { timestamp, token, signature: given } = signature
    if (typeof timestamp !== 'string' || typeof token !== 'string' || typeof given !== 'string') {
      return notVerified()
    }
    if (!signedWith(key, timestamp, token, given)) return notVerified()
    const signedAt = Number(timestamp)
    if (!Number.isFinite(signedAt) || Math.abs(now / 1000 - signedAt) > WINDOW_SECONDS) {
      return notVerified()
    }
    const eventId = data['id']
    if (typeof eventId !== 'string' || eventId === '') return notVerified()
    const seen = tokens.get(token)
    if (seen !== undefined && seen.eventId !== eventId) return notVerified()
    if (seen === undefined) {
      tokens.set(token, { eventId, expiresAt: (signedAt + WINDOW_SECONDS) * 1000 })
    }

    return { verified: true, deliveryId: eventId, events: eventsOf(data) }
  }
}
