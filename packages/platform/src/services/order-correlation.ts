import type { Order } from '@nymbalhq/types'
import { runWithCorrelation } from '../events/correlation.js'

/**
 * Runs `fn` in the correlation scope of the checkout that placed `order`: checkout records its id in the order's
 * metadata, since the payment arrives in a request of its own. An order placed without one keeps the caller's scope.
 */
export function inOrderScope<T>(order: Order | null, fn: () => T): T {
  const id = (order?.metadata as { correlationId?: unknown } | undefined)?.correlationId
  return typeof id === 'string' ? runWithCorrelation(id, fn) : fn()
}
