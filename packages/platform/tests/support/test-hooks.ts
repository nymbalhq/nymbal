import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  ShippingAdapter,
  TaxAdapter,
  WebhookDelivery,
  WebhookEventDraft,
  WebhookHeaders,
} from '@nymbalhq/types'

// A provider of the tests' own that takes webhooks: an HMAC-SHA256 over the raw body in `x-test-signature` (hex), and a
// JSON body `{ id, events }` whose `id` is the delivery id and whose `events` are handed on as they came. So a test
// chooses the events a delivery carries, bad ones included, by what it signs. Injected as a `custom` shipping adapter
// (or tax, for a second hooked slot). Depends on nothing of the kernel's, so the contract runner can build it.

export const TEST_HOOKS = 'test-hooks'
export const TEST_HOOKS_SECRET = 'whsec_test_hooks_only'
export const SIGNATURE_HEADER = 'x-test-signature'

/** The types the default adapter declares in `producesEvents`. */
export const TEST_HOOKS_EVENTS = [
  'test-hooks.parcel_updated.v1',
  'test-hooks.parcel_delivered.v1',
  'test-hooks.parcel_returned.v2',
] as const

export interface TestHooksOptions {
  providerName?: string
  producesEvents?: readonly string[]
  secret?: string
  /** Without it the adapter has no `receiveWebhook`: a provider of the same name that takes no deliveries. */
  hooked?: boolean
  /** Defect: a new delivery id on every call, so a provider retry looks like a new delivery. */
  freshDeliveryId?: boolean
  /** Defect: every event's type rewritten, e.g. into a kernel namespace. */
  rewriteType?: string
}

/** The body a delivery carries before it is signed. */
export interface DeliveryBody {
  id: string
  events: unknown[]
}

export interface SignedDelivery {
  rawBody: Buffer
  headers: WebhookHeaders
}

function signatureOf(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

function verifies(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined) return false
  const expected = Buffer.from(signatureOf(rawBody, secret), 'utf8')
  const given = Buffer.from(header, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

const NOT_VERIFIED: WebhookDelivery = { verified: false, deliveryId: '', events: [] }

function receiver(opts: TestHooksOptions) {
  const secret = opts.secret ?? TEST_HOOKS_SECRET
  return async function receiveWebhook(
    rawBody: Buffer,
    headers: WebhookHeaders,
  ): Promise<WebhookDelivery> {
    if (!verifies(rawBody, headerValue(headers, SIGNATURE_HEADER), secret)) return NOT_VERIFIED
    let body: DeliveryBody
    try {
      body = JSON.parse(rawBody.toString('utf8')) as DeliveryBody
    } catch {
      return NOT_VERIFIED
    }
    const events = (Array.isArray(body.events) ? body.events : []) as WebhookEventDraft[]
    return {
      verified: true,
      deliveryId: opts.freshDeliveryId === true ? randomUUID() : body.id,
      events:
        opts.rewriteType === undefined
          ? events
          : events.map((event) => ({ ...event, type: opts.rewriteType! })),
    }
  }
}

function base(opts: TestHooksOptions) {
  return {
    providerName: opts.providerName ?? TEST_HOOKS,
    capabilities: () => ['webhooks'],
    producesEvents: [...(opts.producesEvents ?? TEST_HOOKS_EVENTS)],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return { status: 'healthy' as const }
    },
    ...(opts.hooked !== false && { receiveWebhook: receiver(opts) }),
  }
}

/** The test provider as a shipping adapter: flat rates, labels and tracking, and its webhook. */
export function createTestHooksAdapter(opts: TestHooksOptions = {}): ShippingAdapter {
  return {
    kind: 'shipping',
    ...base(opts),
    async rate(params) {
      return [
        {
          carrier: TEST_HOOKS,
          service: 'standard',
          amountMinor: 0,
          currency: params.currency,
          estimatedDays: 2,
        },
      ]
    },
    async createLabel(params) {
      return {
        labelUrl: `data:text/plain,${params.orderId}`,
        trackingNumber: `TH-${params.orderId}`,
        carrier: params.carrier,
      }
    },
    async track() {
      return { status: 'in_transit', lastUpdateAt: new Date(0).toISOString() }
    },
  }
}

/** The same provider shape in the tax slot, for a store with a second hooked (or same-named) slot. */
export function createTestHooksTaxAdapter(opts: TestHooksOptions = {}): TaxAdapter {
  return {
    kind: 'tax',
    ...base(opts),
    async calculate(params) {
      return { totalTaxMinor: 0, ratePerLine: params.lines.map(() => ({ taxMinor: 0 })) }
    },
  }
}

/** `body` as the provider sends it: JSON, signed with `secret` (the adapter's default unless given). */
export function signedDelivery(
  body: DeliveryBody | string,
  secret: string = TEST_HOOKS_SECRET,
): SignedDelivery {
  const rawBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signatureOf(rawBody, secret),
    },
  }
}

/** The same delivery with one byte of its body changed and its signature kept. */
export function tampered(delivery: SignedDelivery): SignedDelivery {
  const rawBody = Buffer.from(delivery.rawBody)
  // The first character of the delivery id, so the body still parses and only the signature can tell.
  const idAt = rawBody.indexOf('"id":"')
  const at = idAt === -1 ? rawBody.length - 1 : idAt + 6
  rawBody[at] = rawBody[at]! ^ 0x01
  return { rawBody, headers: delivery.headers }
}

/** A well-formed delivery of the default adapter: `events` of its declared types, each with a payload. */
export function sampleBody(id: string = `dlv_${randomUUID()}`, count = 2): DeliveryBody {
  return {
    id,
    events: Array.from({ length: count }, (_, i) => ({
      type: TEST_HOOKS_EVENTS[i % TEST_HOOKS_EVENTS.length]!,
      payload: { parcelId: `parcel-${id}`, step: i },
    })),
  }
}
