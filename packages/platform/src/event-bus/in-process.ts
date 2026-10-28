import { v7 as uuidv7 } from 'uuid'
import type {
  EventBusAdapter,
  EventHandler,
  HandlerFailure,
  HealthReport,
  NymbalEvent,
  Subscription,
  SubscriptionConfig,
  Logger,
} from '@nymbalhq/types'
import { handlerFailedError, ValidationError } from '@nymbalhq/types'

interface Registration {
  id: string
  patterns: string[]
  regexes: RegExp[]
  handler: EventHandler
  config: SubscriptionConfig | undefined
}

export interface InProcessEventBusOptions {
  logger?: Logger
}

export class InProcessEventBus implements EventBusAdapter {
  readonly #registrations = new Map<string, Registration>()
  readonly #logger: Logger | undefined

  constructor(options: InProcessEventBusOptions = {}) {
    this.#logger = options.logger
  }

  capabilities(): readonly string[] {
    return ['publish', 'subscribe', 'wildcard', 'replay']
  }

  /** Delivery within the process: healthy whenever it can answer. */
  async healthCheck(): Promise<HealthReport> {
    return { status: 'healthy' }
  }

  async publish<T>(event: NymbalEvent<T>): Promise<void> {
    const failed = await this.#deliver(event, () => true)
    if (failed.length > 0) throw handlerFailedError(event, failed)
  }

  async publishBatch(events: NymbalEvent<unknown>[]): Promise<void> {
    let first: Error | undefined
    for (const event of events) {
      const failed = await this.#deliver(event, () => true)
      if (failed.length > 0) first ??= handlerFailedError(event, failed)
    }
    if (first !== undefined) throw first
  }

  async replay(events: NymbalEvent<unknown>[]): Promise<void> {
    for (const event of events) {
      await this.#deliver(event, (r) => r.config?.derived === true)
    }
  }

  /** Runs every matching handler to the end, each error logged; returns the named subscriptions that threw. */
  async #deliver<T>(
    event: NymbalEvent<T>,
    eligible: (r: Registration) => boolean,
  ): Promise<HandlerFailure[]> {
    this.#validate(event)
    const matches = Array.from(this.#registrations.values()).filter(
      (r) => eligible(r) && r.regexes.some((re) => re.test(event.type)),
    )
    const outcomes = await Promise.all(
      matches.map(async (r): Promise<HandlerFailure | null> => {
        try {
          await r.handler(event)
          return null
        } catch (err) {
          const subscription = r.config?.name
          this.#logger?.error(
            { err, subscriptionId: r.id, subscription, eventType: event.type, eventId: event.id },
            'Event handler failed',
          )
          return subscription === undefined ? null : { subscription, message: messageOf(err) }
        }
      }),
    )
    return outcomes.filter((o) => o !== null)
  }

  async subscribe(
    eventPattern: string | string[],
    handler: EventHandler,
    config?: SubscriptionConfig,
  ): Promise<Subscription> {
    const patterns = Array.isArray(eventPattern) ? eventPattern : [eventPattern]
    const regexes = patterns.map(compilePattern)
    const id = uuidv7()
    const registration: Registration = { id, patterns, regexes, handler, config }
    this.#registrations.set(id, registration)
    const self = this
    return {
      id,
      patterns,
      async unsubscribe() {
        self.#registrations.delete(id)
      },
    }
  }

  async unsubscribe(subscription: Subscription): Promise<void> {
    this.#registrations.delete(subscription.id)
  }

  async close(): Promise<void> {
    this.#registrations.clear()
  }

  #validate(event: NymbalEvent<unknown>): void {
    if (!event.id || !event.type || !event.timestamp || !event.source) {
      throw new ValidationError('Event is missing required envelope fields', {
        context: { event },
      })
    }
    if (!event.metadata || !event.metadata.storeId || !event.metadata.environment) {
      throw new ValidationError('Event metadata is missing required fields', {
        context: { event },
      })
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\*]/g, '\\$&').replace(/\\\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}
