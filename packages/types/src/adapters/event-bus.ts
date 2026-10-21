import type { NymbalEvent, EventHandler } from '../events/envelope.js'
import type { HealthReport } from './adapter-base.js'

export interface RetryPolicy {
  maxAttempts: number
  backoff: 'exponential' | 'linear' | 'fixed'
  initialDelayMs?: number
}

export interface SubscriptionConfig {
  retryPolicy?: RetryPolicy
  deadLetterQueue?: string
  batchSize?: number
  /**
   * A named subscription is handled once per name across every bus instance (one consumer group); an unnamed one is
   * handled by every subscriber on every instance. On a single-process bus the two are the same.
   */
  name?: string
  /** The subscriber only maintains derived state (a projection, a search index): it also receives `replay`. */
  derived?: boolean
}

export interface Subscription {
  id: string
  patterns: string[]
  unsubscribe(): Promise<void>
}

/**
 * Delivery is at least once: a publish that is retried may reach a handler twice, so every handler is idempotent
 * (projections overwrite their documents, side effects use `withIdempotency`).
 */
export interface EventBusAdapter {
  capabilities(): readonly string[]
  /**
   * Resolves only after every matching subscription this instance holds has handled the event, so a read straight
   * after a command sees its projections. A handler that throws is logged, and does not reject the publish.
   */
  publish<T>(event: NymbalEvent<T>): Promise<void>
  publishBatch(events: NymbalEvent<unknown>[]): Promise<void>
  /** Delivers to `derived` subscriptions only, so rebuilding derived state never triggers side effects. */
  replay(events: NymbalEvent<unknown>[]): Promise<void>
  subscribe(
    eventPattern: string | string[],
    handler: EventHandler,
    config?: SubscriptionConfig,
  ): Promise<Subscription>
  unsubscribe(subscription: Subscription): Promise<void>
  close(): Promise<void>
  /**
   * Whether the bus can deliver, within `HEALTH_CHECK_TIMEOUT_MS`. Optional, so a bus written before it existed still
   * type-checks; `nymbal doctor` reports one without it as `no healthCheck`.
   */
  healthCheck?(): Promise<HealthReport>
}
