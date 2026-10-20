import type { NymbalEvent, EventHandler } from '../events/envelope.js'

export interface RetryPolicy {
  maxAttempts: number
  backoff: 'exponential' | 'linear' | 'fixed'
  initialDelayMs?: number
}

export interface SubscriptionConfig {
  retryPolicy?: RetryPolicy
  deadLetterQueue?: string
  batchSize?: number
  name?: string
  /** The subscriber only maintains derived state (a projection, a search index): it also receives `replay`. */
  derived?: boolean
}

export interface Subscription {
  id: string
  patterns: string[]
  unsubscribe(): Promise<void>
}

export interface EventBusAdapter {
  capabilities(): readonly string[]
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
}
