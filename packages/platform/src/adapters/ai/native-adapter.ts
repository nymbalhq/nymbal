import type { AiAdapter, Logger } from '@nymbal/types'
import { AdapterError } from '@nymbal/types'
import { noopInitialize, okHealth } from '../base.js'

export function createNativeAiAdapter(_logger: Logger): AiAdapter {
  return {
    kind: 'ai',
    providerName: 'native',
    capabilities: [],
    producesEvents: [],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth('AI adapter is stubbed — configure a real provider for v1.0'),
    async embed() {
      throw new AdapterError('not_configured', 'AI embedding is not configured in v0.1')
    },
    async complete() {
      throw new AdapterError('not_configured', 'AI completion is not configured in v0.1')
    },
  }
}
