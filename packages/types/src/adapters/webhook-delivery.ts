import { STANDARD_EVENT_TYPES } from '../events/constants.js'
import type { WebhookDelivery } from './commerce.js'

/** Why a delivery's events may not be published; `type` is the offending event's, when one is to blame. */
export interface WebhookDeliveryProblem {
  type?: unknown
  reason: string
}

const VERSIONED_EVENT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.v[1-9][0-9]*$/
const KERNEL_NAMESPACES = new Set(STANDARD_EVENT_TYPES.map((type) => type.split('.')[0]!))

/** Plain JSON objects only: a class instance would not survive the event log's serialisation as itself. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * The first thing that makes a verified delivery from the adapter named `providerName` unpublishable, or null when
 * every event may be published: the rule of `receiveWebhook`, which the kernel refuses a delivery for and the
 * webhook contract suite certifies.
 */
export function webhookDeliveryProblem(
  providerName: string,
  producesEvents: readonly string[],
  delivery: WebhookDelivery,
): WebhookDeliveryProblem | null {
  if (typeof delivery.deliveryId !== 'string' || delivery.deliveryId === '') {
    return { reason: 'the delivery id is empty' }
  }
  if (!Array.isArray(delivery.events)) return { reason: 'events is not an array' }
  for (const event of delivery.events as unknown[]) {
    const { type, payload } = (isPlainObject(event) ? event : {}) as {
      type?: unknown
      payload?: unknown
    }
    if (typeof type !== 'string') return { type, reason: 'an event has no type' }
    const dot = type.indexOf('.')
    // A provider name holding a dot never equals the text before the first dot, so it can publish nothing.
    if (dot === -1 || type.slice(0, dot) !== providerName) {
      return { type, reason: `the type is not in the ${providerName} namespace` }
    }
    if (KERNEL_NAMESPACES.has(providerName)) {
      return { type, reason: 'the type is in a kernel namespace' }
    }
    if (!VERSIONED_EVENT.test(type.slice(dot + 1))) {
      return { type, reason: 'the type is not <provider>.<event>.v<n>' }
    }
    if (!producesEvents.includes(type)) {
      return { type, reason: 'the type is not listed in producesEvents' }
    }
    if (!isPlainObject(payload)) return { type, reason: 'the payload is not a JSON object' }
  }
  return null
}
