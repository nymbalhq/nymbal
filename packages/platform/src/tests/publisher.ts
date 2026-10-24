import type { EventBusAdapter, Logger } from '@nymbalhq/types'
import type { EventBuilderContext } from '../events/builder.js'

// The one place tests wire an event publisher: the outbox is mandatory, so a publisher needs the command store, the
// event log on that store and a relay that drains it onto the bus.
//
// The factories are passed in rather than imported here: the store, the log, the relay and the publisher must come
// from one module instance (platform tests use `src/`, the importers use `dist/` through @nymbalhq/platform), or the
// relay's reads and the publisher's appends would not join the store's transaction context. The types are generic
// for the same reason: `src` and `dist` declare their own CommandStore.

export interface OutboxFactories<Store, EventLog, Relay, Publisher> {
  createRelay(opts: {
    store: Store
    eventLog: EventLog
    eventBus: EventBusAdapter
    logger: Logger
    maxAttempts?: number
    intervalMs?: number
  }): Relay
  createEventPublisher(opts: {
    eventBus: EventBusAdapter
    builderContext: EventBuilderContext
    store: Store
    eventLog: EventLog
    relay: Relay
    correlationId?: string
  }): Publisher
}

export const TEST_BUILDER_CONTEXT: EventBuilderContext = {
  storeId: 'test',
  environment: 'development',
  version: '0.0.0',
  source: 'test',
}

export interface WiredPublisher<Relay, Publisher> {
  publisher: Publisher
  /** Not started: tests drain it explicitly, or rely on the drain every publish awaits. */
  relay: Relay
}

export function wirePublisher<Store, EventLog, Relay, Publisher>(
  factories: OutboxFactories<Store, EventLog, Relay, Publisher>,
  opts: {
    store: Store
    eventLog: EventLog
    eventBus: EventBusAdapter
    logger: Logger
    builderContext?: EventBuilderContext
  },
): WiredPublisher<Relay, Publisher> {
  const relay = factories.createRelay({
    store: opts.store,
    eventLog: opts.eventLog,
    eventBus: opts.eventBus,
    logger: opts.logger,
  })
  const publisher = factories.createEventPublisher({
    eventBus: opts.eventBus,
    builderContext: opts.builderContext ?? TEST_BUILDER_CONTEXT,
    store: opts.store,
    eventLog: opts.eventLog,
    relay,
  })
  return { publisher, relay }
}
