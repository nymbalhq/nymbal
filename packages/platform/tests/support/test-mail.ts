import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  EmailAdapter,
  TransactionalEmail,
  WebhookDelivery,
  WebhookEventDraft,
  WebhookHeaders,
} from '@nymbalhq/types'

// An email provider of the tests' own that reports bounces and complaints by webhook: an HMAC-SHA256 over the raw body
// in `x-test-signature` (hex), in one of three encodings a real provider uses (a JSON body, a form post, and an
// SNS-style `text/plain` notification whose `Message` is JSON). Each provider event becomes `test-mail.bounced.v1` or
// `test-mail.complained.v1`, its fields handed on as the provider sent them, so a test chooses what the kernel must
// refuse by what it signs. It captures every send. A failure switch takes the provider down (every send rejects and
// the health check answers `down`) and back up. Injected as a `custom` email adapter; depends on nothing of the
// kernel's, so the contract runner can build it.

export const TEST_MAIL = 'test-mail'
export const TEST_MAIL_SECRET = 'whsec_test_mail_only'
export const SIGNATURE_HEADER = 'x-test-signature'
export const BOUNCED = `${TEST_MAIL}.bounced.v1`
export const COMPLAINED = `${TEST_MAIL}.complained.v1`
export const TEST_MAIL_EVENTS = [BOUNCED, COMPLAINED] as const

/** One bounce or complaint as the provider reports it. Every field may be missing or wrong: it is handed on as sent. */
export interface ProviderEvent {
  type: 'bounce' | 'complaint'
  recipient?: unknown
  /** `hard` or `soft`, the provider's own classification. */
  bounce?: unknown
  message_id?: unknown
  occurred_at?: unknown
}

/** A JSON delivery: the provider's id for it, and its events. */
export interface MailBody {
  id: string
  events: ProviderEvent[]
}

export interface SignedDelivery {
  rawBody: Buffer
  headers: WebhookHeaders
}

export interface TestMailOptions {
  providerName?: string
  producesEvents?: readonly string[]
  secret?: string
  /** Defect: a new delivery id on every call, so a provider retry looks like a new delivery. */
  freshDeliveryId?: boolean
  /** Defect: beside each event, a copy of it with no recipient. */
  recipientlessCopy?: boolean
}

export interface TestMailAdapter extends EmailAdapter {
  /** Every send, in order. */
  readonly sent: TransactionalEmail[]
  /** Every send refused while the provider was down, in order. */
  readonly refused: TransactionalEmail[]
  /** From now on every send rejects with `detail` and the health check answers `down` with it, until `up()`. */
  down(detail?: string): void
  /** Sends and the health check work again. */
  up(): void
}

function signatureOf(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function verifies(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined) return false
  const expected = Buffer.from(signatureOf(rawBody, secret), 'utf8')
  const given = Buffer.from(header, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const NOT_VERIFIED: WebhookDelivery = { verified: false, deliveryId: '', events: [] }

/** The delivery a body holds, by its content type; null when it does not parse. */
function parse(rawBody: Buffer, contentType: string): MailBody | null {
  const text = rawBody.toString('utf8')
  try {
    if (contentType.startsWith('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(text)
      const event: Record<string, unknown> = { type: form.get('type') }
      for (const field of ['recipient', 'bounce', 'message_id', 'occurred_at']) {
        const value = form.get(field)
        if (value !== null) event[field] = value
      }
      return { id: form.get('id') ?? '', events: [event as unknown as ProviderEvent] }
    }
    if (contentType.startsWith('text/plain')) {
      const notification = JSON.parse(text) as { MessageId?: unknown; Message?: unknown }
      const message = JSON.parse(String(notification.Message)) as ProviderEvent
      return { id: String(notification.MessageId ?? ''), events: [message] }
    }
    const body = JSON.parse(text) as Partial<MailBody>
    return { id: String(body.id ?? ''), events: Array.isArray(body.events) ? body.events : [] }
  } catch {
    return null
  }
}

function draft(event: ProviderEvent, providerName: string): WebhookEventDraft | null {
  const payload: Record<string, unknown> = {}
  if ('recipient' in event) payload['recipient'] = event.recipient
  if (event.type === 'bounce' && 'bounce' in event) payload['bounce'] = event.bounce
  payload['messageId'] = 'message_id' in event ? event.message_id : null
  if ('occurred_at' in event) payload['occurredAt'] = event.occurred_at
  if (event.type === 'bounce') return { type: `${providerName}.bounced.v1`, payload }
  if (event.type === 'complaint') return { type: `${providerName}.complained.v1`, payload }
  return null
}

export function createTestMailAdapter(opts: TestMailOptions = {}): TestMailAdapter {
  const providerName = opts.providerName ?? TEST_MAIL
  const secret = opts.secret ?? TEST_MAIL_SECRET
  const sent: TransactionalEmail[] = []
  const refused: TransactionalEmail[] = []
  let outage: string | null = null
  return {
    kind: 'email',
    providerName,
    sent,
    refused,
    down(detail = `${providerName}: connection refused`) {
      outage = detail
    },
    up() {
      outage = null
    },
    capabilities: () => ['transactional', 'webhooks'],
    producesEvents: [
      ...(opts.producesEvents ?? [`${providerName}.bounced.v1`, `${providerName}.complained.v1`]),
    ],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return outage === null
        ? { status: 'healthy' as const }
        : { status: 'down' as const, detail: outage }
    },
    async sendTransactional(message) {
      if (outage !== null) {
        refused.push(message)
        throw new Error(outage)
      }
      sent.push(message)
      return { messageId: `${providerName}-${sent.length}`, accepted: true }
    },
    async syncCustomerToList() {},
    async removeCustomerFromList() {},
    async receiveWebhook(rawBody, headers) {
      if (!verifies(rawBody, headerValue(headers, SIGNATURE_HEADER), secret)) return NOT_VERIFIED
      const body = parse(rawBody, headerValue(headers, 'content-type') ?? 'application/json')
      if (body === null) return NOT_VERIFIED
      const events: WebhookEventDraft[] = []
      for (const event of body.events) {
        const made = draft(event, providerName)
        if (made === null) continue
        events.push(made)
        if (opts.recipientlessCopy === true) {
          const { recipient: _dropped, ...rest } = made.payload
          events.push({ type: made.type, payload: rest })
        }
      }
      return {
        verified: true,
        deliveryId: opts.freshDeliveryId === true ? randomUUID() : body.id,
        events,
      }
    },
  }
}

function signed(rawBody: Buffer, contentType: string, secret: string): SignedDelivery {
  return {
    rawBody,
    headers: { 'content-type': contentType, [SIGNATURE_HEADER]: signatureOf(rawBody, secret) },
  }
}

/** A JSON delivery of any number of events, signed. */
export function jsonDelivery(body: MailBody, secret: string = TEST_MAIL_SECRET): SignedDelivery {
  return signed(Buffer.from(JSON.stringify(body), 'utf8'), 'application/json', secret)
}

/** A form post of one event: fields `id`, `type`, `recipient`, `bounce`, `occurred_at` (and `message_id`), signed. */
export function formDelivery(
  id: string,
  event: ProviderEvent,
  secret: string = TEST_MAIL_SECRET,
): SignedDelivery {
  const form = new URLSearchParams({ id, type: event.type })
  for (const field of ['recipient', 'bounce', 'message_id', 'occurred_at'] as const) {
    if (field in event) form.set(field, String(event[field]))
  }
  return signed(Buffer.from(form.toString(), 'utf8'), 'application/x-www-form-urlencoded', secret)
}

/** An SNS-style `text/plain` notification of one event, its `Message` the event as JSON, signed. */
export function textDelivery(
  id: string,
  event: ProviderEvent,
  secret: string = TEST_MAIL_SECRET,
): SignedDelivery {
  const notification = { Type: 'Notification', MessageId: id, Message: JSON.stringify(event) }
  return signed(
    Buffer.from(JSON.stringify(notification), 'utf8'),
    'text/plain; charset=utf-8',
    secret,
  )
}

export type Encoding = 'json' | 'form' | 'text'

/** One event in the given encoding. */
export function deliveryOf(encoding: Encoding, id: string, event: ProviderEvent): SignedDelivery {
  if (encoding === 'form') return formDelivery(id, event)
  if (encoding === 'text') return textDelivery(id, event)
  return jsonDelivery({ id, events: [event] })
}

/** The same delivery with one byte of its body changed and its signature kept. */
export function tampered(delivery: SignedDelivery): SignedDelivery {
  const rawBody = Buffer.from(delivery.rawBody)
  const at = Math.floor(rawBody.length / 2)
  rawBody[at] = rawBody[at]! ^ 0x01
  return { rawBody, headers: delivery.headers }
}

export const hardBounce = (recipient: string, at = new Date()): ProviderEvent => ({
  type: 'bounce',
  recipient,
  bounce: 'hard',
  occurred_at: at.toISOString(),
})

export const softBounce = (recipient: string, at = new Date()): ProviderEvent => ({
  type: 'bounce',
  recipient,
  bounce: 'soft',
  occurred_at: at.toISOString(),
})

export const complaint = (recipient: string, at = new Date()): ProviderEvent => ({
  type: 'complaint',
  recipient,
  occurred_at: at.toISOString(),
})
