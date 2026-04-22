import { v7 as uuidv7 } from 'uuid'
import type {
  EventBusAdapter,
  EventHandler,
  NymbalEvent,
  Subscription,
  SubscriptionConfig,
  Logger,
} from '@nymbal/types'
import { ValidationError } from '@nymbal/types'

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

  async publish<T>(event: NymbalEvent<T>): Promise<void> {
    this.#validate(event)
    const matches = Array.from(this.#registrations.values()).filter((r) =>
      r.regexes.some((re) => re.test(event.type)),
    )
    await Promise.all(
      matches.map(async (r) => {
        try {
          await r.handler(event)
        } catch (err) {
          this.#logger?.error(
            { err, subscriptionId: r.id, eventType: event.type, eventId: event.id },
            'Event handler failed',
          )
        }
      }),
    )
  }

  async publishBatch(events: NymbalEvent<unknown>[]): Promise<void> {
    for (const event of events) {
      await this.publish(event)
    }
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

function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\*]/g, '\\$&').replace(/\\\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}
