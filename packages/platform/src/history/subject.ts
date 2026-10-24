import type { NymbalEvent } from '@nymbalhq/types'

/** The record an event is about: what `events.subject_type` and `events.subject_id` hold. */
export interface EventSubject {
  type: string
  id: string
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nestedId(value: unknown): string | undefined {
  return value !== null && typeof value === 'object'
    ? text((value as { id?: unknown }).id)
    : undefined
}

/**
 * Whose event this is, by its type's prefix and the payload path that names the record; null when the type names no
 * record or the payload lacks its id. Migration 0012's backfill mirrors this, rule for rule.
 */
export function subjectOf(
  envelope: Pick<NymbalEvent<unknown>, 'type' | 'payload'>,
): EventSubject | null {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>
  const type = envelope.type
  let subject: EventSubject['type'] | undefined
  let id: string | undefined
  if (type.startsWith('product.')) {
    subject = 'product'
    id = nestedId(payload['product']) ?? text(payload['productId'])
  } else if (type.startsWith('order.') || type.startsWith('payment.')) {
    subject = 'order'
    id = nestedId(payload['order']) ?? text(payload['orderId'])
  } else if (type.startsWith('customer.')) {
    subject = 'customer'
    id = text(payload['customerId'])
  } else if (type.startsWith('inventory.')) {
    subject = 'variant'
    id = text(payload['variantId'])
  }
  return subject === undefined || id === undefined ? null : { type: subject, id }
}
