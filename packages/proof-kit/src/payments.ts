import { randomUUID } from 'node:crypto'

export interface StubPaymentWebhookOptions {
  paymentIntentId: string
  amountMinor: number
  currency: string
  kind?: 'payment.captured' | 'payment.failed'
  eventId?: string
}

export interface StubPaymentWebhookRequest {
  method: 'POST'
  path: '/api/webhooks/stripe'
  headers: Record<string, string>
  body: string
}

/**
 * The request the stub payments adapter's parseWebhook accepts as verified: it checks no signature, but the route
 * insists the header is present. The body id is the route's dedupe key, so it is unique unless the caller repeats it.
 */
export function stubPaymentWebhook(opts: StubPaymentWebhookOptions): StubPaymentWebhookRequest {
  return {
    method: 'POST',
    path: '/api/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'proof-kit-stub' },
    body: JSON.stringify({
      id: opts.eventId ?? `evt_${randomUUID()}`,
      kind: opts.kind ?? 'payment.captured',
      paymentIntentId: opts.paymentIntentId,
      amountMinor: opts.amountMinor,
      currency: opts.currency,
    }),
  }
}

/** Sends the webhook to a running store's real route and returns what it answered. */
export async function finaliseStubPayment(
  baseUrl: string,
  opts: StubPaymentWebhookOptions,
): Promise<{ status: number; body: unknown }> {
  const request = stubPaymentWebhook(opts)
  const res = await fetch(new URL(request.path, baseUrl), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}
