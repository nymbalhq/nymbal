import type { Logger, ShippingAdapter } from '@nymbalhq/types'
import { noopInitialize, okHealth } from '../base.js'

/** The store ships by hand: no rates, labels or tracking registration, so no word and none of their methods. */
export function createNativeShippingAdapter(_logger: Logger): ShippingAdapter {
  return {
    kind: 'shipping',
    providerName: 'native',
    capabilities: () => [],
    producesEvents: [],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),
  }
}
