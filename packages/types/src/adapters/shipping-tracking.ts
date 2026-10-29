import type { WebhookDelivery } from './commerce.js'
import type { WebhookDeliveryProblem } from './webhook-delivery.js'

/** The statuses a shipping adapter maps its carrier's onto; one it cannot map is `unknown`. */
export const SHIPPING_TRACKING_STATUSES = [
  'pre_transit',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'returned',
  'unknown',
] as const

export type ShippingTrackingStatus = (typeof SHIPPING_TRACKING_STATUSES)[number]

/** `<providerName>.tracking.v1`: the carrier reported `status` for the parcel `trackingNumber`. */
export interface ShippingTrackingV1Payload {
  trackingNumber: string
  /** The carrier's code as the adapter's provider gives it, which need not match the merchant's own. */
  carrier: string | null
  status: ShippingTrackingStatus
  /** ISO 8601. */
  occurredAt: string
}

/** The event type a shipping adapter publishes a tracking update under. */
export function shippingTrackingType(providerName: string): string {
  return `${providerName}.tracking.v1`
}

/** A tracking number as stored and looked up: no whitespace, upper case, so a carrier's spelling finds the merchant's. */
export function normaliseTrackingNumber(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

function payloadOf(event: unknown): Record<string, unknown> {
  const payload = (event as { payload?: unknown } | null)?.payload
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

/**
 * The first tracking update in a verified delivery from the shipping adapter `providerName` that the kernel cannot act
 * on, or null when there is none. The route refuses such a delivery whole, before claiming it, so the provider's retry
 * after the adapter is fixed is still received; the shipping tracking contract suite certifies the same rule.
 */
export function shippingTrackingProblem(
  providerName: string,
  delivery: WebhookDelivery,
): WebhookDeliveryProblem | null {
  const tracking = shippingTrackingType(providerName)
  if (!Array.isArray(delivery.events)) return null
  for (const event of delivery.events as unknown[]) {
    const type = (event as { type?: unknown } | null)?.type
    if (type !== tracking) continue
    const { trackingNumber, carrier, status, occurredAt } = payloadOf(event)
    if (typeof trackingNumber !== 'string' || normaliseTrackingNumber(trackingNumber) === '') {
      return { type, reason: 'the trackingNumber is missing or empty' }
    }
    if (carrier !== null && typeof carrier !== 'string') {
      return { type, reason: 'the carrier is neither a string nor null' }
    }
    if (!(SHIPPING_TRACKING_STATUSES as readonly unknown[]).includes(status)) {
      return { type, reason: 'the status is not one of the tracking statuses' }
    }
    if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
      return { type, reason: 'occurredAt is not a readable date' }
    }
  }
  return null
}
