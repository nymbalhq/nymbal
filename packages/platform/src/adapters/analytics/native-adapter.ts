import type { AnalyticsAdapter, Logger } from '@nymbal/types'
import { noopInitialize, okHealth } from '../base.js'

export function createNativeAnalyticsAdapter(logger: Logger): AnalyticsAdapter {
  const log = logger.child({ adapter: 'analytics', provider: 'native' })
  return {
    kind: 'analytics',
    providerName: 'native',
    capabilities: ['track', 'identify'],
    producesEvents: [],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),
    async track(event, properties) {
      log.debug({ event, properties }, 'analytics.track')
    },
    async identify(userId, traits) {
      log.debug({ userId, traits }, 'analytics.identify')
    },
  }
}
