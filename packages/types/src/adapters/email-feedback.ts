import type { WebhookDelivery } from './commerce.js'
import type { WebhookDeliveryProblem } from './webhook-delivery.js'

/**
 * `<providerName>.bounced.v1`: a message to `recipient` bounced. `hard` is the provider's permanent failure, `soft`
 * its transient one; a classification the adapter cannot map is `soft`, so a doubtful bounce never suppresses.
 */
export interface EmailBouncedV1Payload {
  recipient: string
  bounce: 'hard' | 'soft'
  /** The `EmailSendResult.messageId` the bounce answers, when the provider gives one. */
  messageId: string | null
  /** ISO 8601. */
  occurredAt: string
}

/** `<providerName>.complained.v1`: `recipient` marked a message as spam. */
export interface EmailComplainedV1Payload {
  recipient: string
  messageId: string | null
  /** ISO 8601. */
  occurredAt: string
}

export type EmailFeedbackKind = 'bounced' | 'complained'

/** The event type an email adapter publishes a bounce or a complaint under. */
export function emailFeedbackType(providerName: string, what: EmailFeedbackKind): string {
  return `${providerName}.${what}.v1`
}

function payloadOf(event: unknown): Record<string, unknown> {
  const payload = (event as { payload?: unknown } | null)?.payload
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

/**
 * The first bounce or complaint in a verified delivery from the email adapter `providerName` that the kernel cannot
 * act on, or null when there is none. The route refuses such a delivery whole, before claiming it, so the provider's
 * retry after the adapter is fixed is still received; the email feedback contract suite certifies the same rule.
 */
export function emailFeedbackProblem(
  providerName: string,
  delivery: WebhookDelivery,
): WebhookDeliveryProblem | null {
  const bounced = emailFeedbackType(providerName, 'bounced')
  const complained = emailFeedbackType(providerName, 'complained')
  if (!Array.isArray(delivery.events)) return null
  for (const event of delivery.events as unknown[]) {
    const type = (event as { type?: unknown } | null)?.type
    if (type !== bounced && type !== complained) continue
    const payload = payloadOf(event)
    const { recipient, messageId, occurredAt } = payload
    if (typeof recipient !== 'string' || recipient.trim() === '') {
      return { type, reason: 'the recipient is missing or empty' }
    }
    if (type === bounced && payload['bounce'] !== 'hard' && payload['bounce'] !== 'soft') {
      return { type, reason: "the bounce is neither 'hard' nor 'soft'" }
    }
    if (messageId !== null && typeof messageId !== 'string') {
      return { type, reason: 'the messageId is neither a string nor null' }
    }
    if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
      return { type, reason: 'occurredAt is not a readable date' }
    }
  }
  return null
}
