import type { Logger, ShippingAdapter } from '@nymbal/types'
import { noopInitialize, okHealth } from '../base.js'

export function createNativeShippingAdapter(logger: Logger): ShippingAdapter {
  const log = logger.child({ adapter: 'shipping', provider: 'native' })
  return {
    kind: 'shipping',
    providerName: 'native',
    capabilities: ['flat-rate'],
    producesEvents: [],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),
    async rate(params) {
      log.debug({ params }, 'shipping.rate')
      return [
        {
          carrier: 'native',
          service: 'standard',
          amountMinor: 500,
          currency: params.currency,
          estimatedDays: 5,
        },
      ]
    },
    async createLabel(params) {
      log.info({ params }, 'shipping.createLabel (stub)')
      return {
        labelUrl: `data:text/plain,order:${params.orderId}`,
        trackingNumber: `NATIVE-${params.orderId.slice(0, 8)}`,
        carrier: params.carrier,
      }
    },
    async track(trackingNumber) {
      return {
        status: 'in_transit',
        lastUpdateAt: new Date().toISOString(),
      }
    },
  }
}
