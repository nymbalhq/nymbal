import { AdapterError } from '../errors.js'
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

/** A named subscription whose handler threw on an event. */
export interface HandlerFailure {
  subscription: string
  message: string
}

/** What `publish` rejects with when a named subscription's handler threw: code `adapter.handler_failed`. */
export function handlerFailedError(
  event: NymbalEvent<unknown>,
  failed: HandlerFailure[],
): AdapterError {
  return new AdapterError(
    'handler_failed',
    `${event.type} (${event.id}) failed in ${failed.map((f) => f.subscription).join(', ')}`,
    { context: { eventId: event.id, eventType: event.type, failed } },
  )
}

/**
 * Delivery is at least once: a failed delivery is published again, to every matching subscription, so every handler
 * is idempotent (projections overwrite their documents, side effects use `withIdempotency`). The bus never retries a
 * failed handler by itself.
 */
export interface EventBusAdapter {
  capabilities(): readonly string[]
  /**
   * Resolves only after every matching subscription this instance holds has handled the event, so a read straight
   * after a command sees its projections. When a named subscription's handler throws, it rejects with
   * `handlerFailedError` naming each one that threw, once every matching handler has settled. An unnamed subscription's
   * throw is logged and does not reject.
   */
  publish<T>(event: NymbalEvent<T>): Promise<void>
  /** Hands every event out in order, then rejects as `publish` does for the first event a named handler failed. */
  publishBatch(events: NymbalEvent<unknown>[]): Promise<void>
  /**
   * Delivers to `derived` subscriptions only, so rebuilding derived state never triggers side effects. A handler's
   * throw is logged and does not reject.
   */
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
