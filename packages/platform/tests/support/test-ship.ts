import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  AdapterError,
  type HealthReport,
  type ShippingAdapter,
  type ShippingLabel,
  type ShippingLabelParams,
  type ShippingRateParams,
  type StartTrackingParams,
  type StartTrackingResult,
  type WebhookDelivery,
  type WebhookEventDraft,
  type WebhookHeaders,
} from '@nymbalhq/types'

// A shipping provider of the tests' own. It rates, sells labels and registers tracking numbers in memory (each method
// present exactly when its word is declared, unless a test says otherwise), and reports a carrier's tracking updates
// by webhook: an HMAC-SHA256 over the raw body in `x-test-signature` (hex), and a JSON body `{ id, updates }` whose `id`
// is the delivery id. Each update becomes one `test-ship.tracking.v1`, its fields handed on as the carrier sent them
// (`tracking_number`, `carrier`, `status`, `occurred_at` → `trackingNumber`, `carrier`, `status`, `occurredAt`), so a
// test chooses what the kernel must refuse by what it signs. `startTracking` records every call and can be told to
// refuse or to reject a number of times, and health can be taken down, so a test plays a provider that refuses or is
// out. Injected as a `custom` shipping adapter; depends on nothing of the kernel's, so the contract runner can build it.

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
  /** What capabilities() answers: all three words unless given (a defect may list any string). */
  words?: readonly string[]
  /** The methods it has; by default the ones its words name (`rates` rate, `labels` createLabel, `tracking` startTracking). */
  methods?: readonly ShipMethod[]
  /** Without it there is no receiveWebhook. Default true. */
  hooked?: boolean
  /** Defect: every buy of a rate id is a new label with a new tracking number, so a retried buy charges twice. */
  buysAgain?: boolean
}

export type ShipMethod = 'rate' | 'createLabel' | 'startTracking'

const METHOD_OF: Readonly<Record<string, ShipMethod>> = {
  rates: 'rate',
  labels: 'createLabel',
  tracking: 'startTracking',
}

/** What one startTracking call answered: `rejected` is a throw. */
export type StartAnswer = StartTrackingResult['status'] | 'rejected'

/** A refusal's reason, or how to write it from the call. */
export type Refusal = string | ((params: StartTrackingParams) => string)

/** The test shipping adapter and its switches. */
export interface TestShipAdapter extends ShippingAdapter {
  /** Every startTracking call, in order, as it was made. */
  readonly startCalls: StartTrackingParams[]
  /** What each startTracking call answered, in order. */
  readonly startAnswers: StartAnswer[]
  /** Every createLabel call, in order. */
  readonly labelCalls: ShippingLabelParams[]
  /** The next `times` startTracking calls reject with AdapterError shipping.unavailable, as an outage or timeout. */
  rejectNext(times: number, detail?: string): void
  /** From now on startTracking answers refused with the reason (null: tracking again). */
  refuse(reason: Refusal | null): void
  /** From now on health answers down with `detail`, until up(). */
  down(detail?: string): void
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

function draft(update: CarrierUpdate, type: string): WebhookEventDraft {
  const payload: Record<string, unknown> = {}
  if ('tracking_number' in update) payload['trackingNumber'] = update.tracking_number
  payload['carrier'] = 'carrier' in update ? update.carrier : null
  if ('status' in update) payload['status'] = update.status
  if ('occurred_at' in update) payload['occurredAt'] = update.occurred_at
  return { type, payload }
}

export function createTestShipAdapter(opts: TestShipOptions = {}): TestShipAdapter {
  const providerName = opts.providerName ?? TEST_SHIP
  const secret = opts.secret ?? TEST_SHIP_SECRET
  const type = `${providerName}.tracking.v1`
  const words = [...(opts.words ?? ['rates', 'labels', 'tracking'])]
  const methods = new Set<ShipMethod>(
    opts.methods ?? words.flatMap((w) => (METHOD_OF[w] === undefined ? [] : [METHOD_OF[w]!])),
  )
  const startCalls: StartTrackingParams[] = []
  const startAnswers: StartAnswer[] = []
  const labelCalls: ShippingLabelParams[] = []
  const issued = new Set<string>()
  const bought = new Map<string, ShippingLabel>()
  let rejectsLeft = 0
  let rejectDetail = 'test-ship: connection refused'
  let refusal: Refusal | null = null
  let downDetail: string | null = null
  let labels = 0

  async function rate(params: ShippingRateParams) {
    const grams = params.parcel.weightGrams
    return ['standard', 'express'].map((service, i) => {
      const id = `tsr_${randomUUID()}`
      issued.add(id)
      return {
        id,
        carrier: providerName,
        service,
        amountMinor: 300 + Math.ceil(grams / 100) * (i + 1),
        currency: 'GBP',
        estimatedDays: i === 0 ? 3 : null,
      }
    })
  }

  async function createLabel(params: ShippingLabelParams): Promise<ShippingLabel> {
    labelCalls.push(params)
    if (!issued.has(params.rateId)) {
      throw new AdapterError('shipping.refused', `test-ship: no rate ${params.rateId}`)
    }
    const before = bought.get(params.rateId)
    if (before !== undefined && opts.buysAgain !== true) return before
    labels += 1
    const trackingNumber = `TS${String(labels).padStart(10, '0')}`
    const label: ShippingLabel = {
      labelUrl: `https://labels.test-ship.invalid/${params.rateId}/${trackingNumber}.pdf`,
      trackingNumber,
      carrier: providerName,
      service: 'standard',
      amountMinor: 300,
      currency: 'GBP',
    }
    bought.set(params.rateId, label)
    return label
  }

  async function startTracking(params: StartTrackingParams): Promise<StartTrackingResult> {
    startCalls.push({ ...params })
    if (rejectsLeft > 0) {
      rejectsLeft -= 1
      startAnswers.push('rejected')
      throw new AdapterError('shipping.unavailable', rejectDetail)
    }
    if (refusal !== null) {
      startAnswers.push('refused')
      return {
        status: 'refused',
        reason: typeof refusal === 'function' ? refusal(params) : refusal,
      }
    }
    startAnswers.push('tracking')
    return { status: 'tracking' }
  }

  async function receiveWebhook(
    rawBody: Buffer,
    headers: WebhookHeaders,
  ): Promise<WebhookDelivery> {
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
  }

  const adapter = {
    kind: 'shipping' as const,
    providerName,
    capabilities: () => words,
    producesEvents: [...(opts.producesEvents ?? [type])],
    consumesEvents: [],
    async initialize() {},
    async healthCheck(): Promise<HealthReport> {
      return downDetail === null ? { status: 'healthy' } : { status: 'down', detail: downDetail }
    },
    ...(methods.has('rate') && { rate }),
    ...(methods.has('createLabel') && { createLabel }),
    ...(methods.has('startTracking') && { startTracking }),
    ...(opts.hooked !== false && { receiveWebhook }),
    startCalls,
    startAnswers,
    labelCalls,
    rejectNext(times: number, detail?: string) {
      rejectsLeft = times
      if (detail !== undefined) rejectDetail = detail
    },
    refuse(reason: Refusal | null) {
      refusal = reason
    },
    down(detail = 'test-ship: unreachable') {
      downDetail = detail
    },
    up() {
      downDetail = null
    },
  }
  // Which methods it has follows its options, which no static type can: a defect may declare any word.
  return adapter as unknown as TestShipAdapter
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
