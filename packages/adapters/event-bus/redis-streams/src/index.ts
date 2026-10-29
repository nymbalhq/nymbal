import { ConfigError, type AdapterContext, type EventBusAdapter } from '@nymbalhq/types'
import {
  createRedisStreamsEventBus,
  RedisStreamsEventBus,
  type RedisStreamsEventBusOptions,
} from './redis-streams-event-bus.js'

export { createRedisStreamsEventBus, RedisStreamsEventBus, type RedisStreamsEventBusOptions }

function positive(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  throw new ConfigError(`@nymbalhq/event-bus-redis-streams: ${name} must be a positive integer`, {
    code: 'config.invalid',
    context: { slot: 'eventBus', [name]: value },
  })
}

/**
 * The kernel's entry: `infrastructure.eventBus: 'redis-streams'`, with `{ url, prefix, ackTimeoutMs, claimIdleMs,
 * streamMaxLen }` from the `redis` block.
 */
export async function createAdapter(ctx: AdapterContext): Promise<EventBusAdapter> {
  if (ctx.slot !== 'eventBus') {
    throw new ConfigError(`@nymbalhq/event-bus-redis-streams serves eventBus, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  const { url, prefix } = ctx.config
  if (typeof url !== 'string' || url === '' || typeof prefix !== 'string' || prefix === '') {
    throw new ConfigError('@nymbalhq/event-bus-redis-streams needs a Redis url and a key prefix', {
      code: 'config.invalid',
      context: { slot: ctx.slot },
    })
  }
  const ackTimeoutMs = positive(ctx.config['ackTimeoutMs'], 'ackTimeoutMs')
  const claimIdleMs = positive(ctx.config['claimIdleMs'], 'claimIdleMs')
  const streamMaxLen = positive(ctx.config['streamMaxLen'], 'streamMaxLen')
  return createRedisStreamsEventBus({
    url,
    prefix,
    logger: ctx.logger,
    ...(ackTimeoutMs !== undefined && { ackTimeoutMs }),
    ...(claimIdleMs !== undefined && { claimIdleMs }),
    ...(streamMaxLen !== undefined && { streamMaxLen }),
  })
}
