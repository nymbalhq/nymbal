import type { EventBusAdapter, NymbalEvent, NymbalEventMap, NymbalEventType } from '@nymbalhq/types'
import { afterCommit, type CommandStore } from '../db/command-store.js'
import type { EventLogRepository } from '../repositories/event-log.js'
import { createEventBuilder, type EventBuilderContext, type MakeEventOptions } from './builder.js'
import type { Relay } from './relay.js'

export interface PublishOptions extends MakeEventOptions {}

export interface EventPublisher {
  publish<E extends NymbalEventType>(
    type: E,
    payload: NymbalEventMap[E],
    options?: PublishOptions,
  ): Promise<NymbalEvent<NymbalEventMap[E]>>
  publishMany(
    events: Array<
      {
        [E in NymbalEventType]: {
          type: E
          payload: NymbalEventMap[E]
          options?: PublishOptions
        }
      }[NymbalEventType]
    >,
  ): Promise<void>
  correlated(correlationId: string): EventPublisher
}

export interface CreatePublisherOptions {
  eventBus: EventBusAdapter
  builderContext: EventBuilderContext
  /** Events are appended to `eventLog` on this store and reach the bus only through `relay`. */
  store: CommandStore
  eventLog: EventLogRepository
  relay: Relay
  correlationId?: string
}

export function createEventPublisher(opts: CreatePublisherOptions): EventPublisher {
  const makeEvent = createEventBuilder(opts.builderContext)
  const { store, eventLog, relay } = opts

  /**
   * Appends in the open transaction (same COMMIT, gone on rollback) or in one of its own, and drains the relay once
   * the outermost transaction has committed; `afterCommit` holds one drain however many publishes the transaction
   * made.
   */
  async function append(events: NymbalEvent<unknown>[]): Promise<void> {
    if (events.length === 0) return
    await store.transaction(async (tx) => {
      await eventLog.append(tx, events)
      await afterCommit(relay.drain)
    })
  }

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
      await append([event])
      return event
    },
    async publishMany(events) {
      await append(events.map((e) => build(e.type, e.payload, e.options ?? {})))
    },
    correlated(correlationId) {
      return createEventPublisher({ ...opts, correlationId })
    },
  }
}
