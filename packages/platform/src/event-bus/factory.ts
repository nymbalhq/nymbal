import type { NymbalConfig } from '@nymbal/config'
import { ConfigError } from '@nymbal/types'
import type { EventBusAdapter, Logger } from '@nymbal/types'
import { InProcessEventBus } from './in-process.js'

export function createEventBus(config: NymbalConfig, logger?: Logger): EventBusAdapter {
  switch (config.infrastructure.eventBus) {
    case 'in-process':
      return new InProcessEventBus(logger ? { logger } : {})
    case 'eventbridge':
    case 'pubsub':
    case 'service-bus':
    case 'redis-streams':
      throw new ConfigError(
        `eventBus=${config.infrastructure.eventBus} is planned for v1.0 and not yet implemented.`,
        { context: { eventBus: config.infrastructure.eventBus } },
      )
    default: {
      const exhaustive: never = config.infrastructure.eventBus
      throw new ConfigError(`Unknown eventBus: ${String(exhaustive)}`)
    }
  }
}
