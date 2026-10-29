import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  ShippingAdapter,
  WebhookDelivery,
  WebhookEventDraft,
  WebhookHeaders,
} from '@nymbalhq/types'

// A shipping provider of the tests' own that reports a carrier's tracking updates by webhook: an HMAC-SHA256 over the
// raw body in `x-test-signature` (hex), and a JSON body `{ id, updates }` whose `id` is the delivery id. Each update
// becomes one `test-ship.tracking.v1`, its fields handed on as the carrier sent them (`tracking_number`, `carrier`,
// `status`, `occurred_at` → `trackingNumber`, `carrier`, `status`, `occurredAt`), so a test chooses what the kernel must
// refuse by what it signs. Injected as a `custom` shipping adapter; depends on nothing of the kernel's, so the contract
// runner can build it.

export const TEST_SHIP = 'test-ship'
export const TEST_SHIP_SECRET = 'whsec_test_ship_only'
export const SIGNATURE_HEADER = 'x-test-signature'
export const TRACKING = `${TEST_SHIP}.tracking.v1`

/** The seven statuses a tracking update is mapped onto. */
export const TRACKING_STATUSES = [
  'pre_transit',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'returned',
  'unknown',
] as const
export type TrackingStatus = (typeof TRACKING_STATUSES)[number]

/** One update as the carrier reports it. Every field may be missing or wrong: it is handed on as sent. */
export interface CarrierUpdate {
  tracking_number?: unknown
  carrier?: unknown
  status?: unknown
  occurred_at?: unknown
}

/** A delivery before it is signed: the provider's id for it, and its updates. */
export interface ShipBody {
  id: string
  updates: CarrierUpdate[]
}

export interface SignedDelivery {
  rawBody: Buffer
  headers: WebhookHeaders
}

export interface TestShipOptions {
  providerName?: string
  producesEvents?: readonly string[]
  secret?: string
  /** Defect: a new delivery id on every call, so a carrier retry looks like a new delivery. */
  freshDeliveryId?: boolean
  /** Defect: beside each event, a copy of it with no tracking number. */
  numberlessCopy?: boolean
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

function draft(update: CarrierUpdate, type: string): WebhookEventDraft {
  const payload: Record<string, unknown> = {}
  if ('tracking_number' in update) payload['trackingNumber'] = update.tracking_number
  payload['carrier'] = 'carrier' in update ? update.carrier : null
  if ('status' in update) payload['status'] = update.status
  if ('occurred_at' in update) payload['occurredAt'] = update.occurred_at
  return { type, payload }
}

export function createTestShipAdapter(opts: TestShipOptions = {}): ShippingAdapter {
  const providerName = opts.providerName ?? TEST_SHIP
  const secret = opts.secret ?? TEST_SHIP_SECRET
  const type = `${providerName}.tracking.v1`
  return {
    kind: 'shipping',
    providerName,
    capabilities: () => ['rates', 'webhooks'],
    producesEvents: [...(opts.producesEvents ?? [type])],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return { status: 'healthy' as const }
    },
    async rate(params) {
      return [
        {
          carrier: providerName,
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
        trackingNumber: `TS-${params.orderId}`,
        carrier: params.carrier,
      }
    },
    async track() {
      return { status: 'unknown', lastUpdateAt: new Date(0).toISOString() }
    },
    async receiveWebhook(rawBody, headers) {
      if (!verifies(rawBody, headerValue(headers, SIGNATURE_HEADER), secret)) return NOT_VERIFIED
      let body: Partial<ShipBody>
      try {
        body = JSON.parse(rawBody.toString('utf8')) as Partial<ShipBody>
      } catch {
        return NOT_VERIFIED
      }
      const updates = Array.isArray(body.updates) ? body.updates : []
      const events: WebhookEventDraft[] = []
      for (const update of updates) {
        const made = draft(update, type)
        events.push(made)
        if (opts.numberlessCopy === true) {
          const { trackingNumber: _dropped, ...rest } = made.payload
          events.push({ type, payload: rest })
        }
      }
      return {
        verified: true,
        deliveryId: opts.freshDeliveryId === true ? randomUUID() : String(body.id ?? ''),
        events,
      }
    },
  }
}

/** A delivery of any number of updates, signed (with the adapter's default secret unless given). */
export function shipDelivery(body: ShipBody, secret: string = TEST_SHIP_SECRET): SignedDelivery {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8')
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signatureOf(rawBody, secret),
    },
  }
}

/** The same delivery with one byte of its delivery id changed and its signature kept, so only the signature tells. */
export function tampered(delivery: SignedDelivery): SignedDelivery {
  const rawBody = Buffer.from(delivery.rawBody)
  const idAt = rawBody.indexOf('"id":"')
  const at = idAt === -1 ? rawBody.length - 1 : idAt + 6
  rawBody[at] = rawBody[at]! ^ 0x01
  return { rawBody, headers: delivery.headers }
}

/** A well-formed update for `trackingNumber`. */
export const update = (
  trackingNumber: string,
  status: TrackingStatus,
  opts: { carrier?: string | null; at?: Date } = {},
): CarrierUpdate => ({
  tracking_number: trackingNumber,
  carrier: opts.carrier === undefined ? 'UPS' : opts.carrier,
  status,
  occurred_at: (opts.at ?? new Date()).toISOString(),
})
