import type {
  EventBusAdapter,
  NymbalEvent,
  NymbalEventMap,
  NymbalEventType,
} from '@nymbal/types'
import { createEventBuilder, type EventBuilderContext, type MakeEventOptions } from './builder.js'

export interface PublishOptions extends MakeEventOptions {}

export interface EventPublisher {
  publish<E extends NymbalEventType>(
    type: E,
    payload: NymbalEventMap[E],
    options?: PublishOptions,
  ): Promise<NymbalEvent<NymbalEventMap[E]>>
  publishMany(
    events: Array<{
      [E in NymbalEventType]: {
        type: E
        payload: NymbalEventMap[E]
        options?: PublishOptions
      }
    }[NymbalEventType]>,
  ): Promise<void>
  correlated(correlationId: string): EventPublisher
}

export interface CreatePublisherOptions {
  eventBus: EventBusAdapter
  builderContext: EventBuilderContext
  correlationId?: string
}

export function createEventPublisher(opts: CreatePublisherOptions): EventPublisher {
  const makeEvent = createEventBuilder(opts.builderContext)

  function build<E extends NymbalEventType>(
    type: E,
    payload: NymbalEventMap[E],
    options: PublishOptions = {},
  ): NymbalEvent<NymbalEventMap[E]> {
    return makeEvent(type, payload, {
      ...(opts.correlationId !== undefined && { correlationId: opts.correlationId }),
      ...options,
    })
  }

  return {
    async publish(type, payload, options) {
      const event = build(type, payload, options ?? {})
      await opts.eventBus.publish(event)
      return event
    },
    async publishMany(events) {
      const built = events.map((e) => build(e.type, e.payload, e.options ?? {}))
      await opts.eventBus.publishBatch(built)
    },
    correlated(correlationId) {
      return createEventPublisher({ ...opts, correlationId })
    },
  }
}
