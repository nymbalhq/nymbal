import { describe, it, expect } from 'vitest'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../src/event-bus/in-process.js'
import { withIdempotency } from '../../src/handlers/idempotency.js'
import { createProcessedEventRepository } from '../../src/repositories/processed-event.js'
import { createLogger } from '../../src/logger.js'
import type { NymbalEvent } from '@nymbal/types'

function makeEvent(id: string, type = 'test.event.v1'): NymbalEvent {
  return {
    id,
    type,
    timestamp: new Date().toISOString(),
    source: 'test',
    correlationId: 'corr',
    payload: { id },
    metadata: { storeId: 'test', environment: 'development', version: '0.0.0' },
  }
}

describe('Event handler idempotency via ProcessedEventRepository', () => {
  it('duplicate event delivery runs handler only once', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const logger = createLogger({ pretty: false, level: 'error' })
    const repo = createProcessedEventRepository(documentStore)

    let callCount = 0
    const handler = withIdempotency('test-handler', async (_event) => { callCount++ }, { repo, logger })

    const event = makeEvent('evt-001')
    await handler(event)
    await handler(event)

    expect(callCount).toBe(1)
  })

  it('distinct events each invoke the handler', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const logger = createLogger({ pretty: false, level: 'error' })
    const repo = createProcessedEventRepository(documentStore)

    let callCount = 0
    const handler = withIdempotency('distinct-handler', async (_event) => { callCount++ }, { repo, logger })

    await handler(makeEvent('evt-distinct-1'))
    await handler(makeEvent('evt-distinct-2'))
    await handler(makeEvent('evt-distinct-3'))

    expect(callCount).toBe(3)
  })

  it('different handler names process the same event independently', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const logger = createLogger({ pretty: false, level: 'error' })
    const repo = createProcessedEventRepository(documentStore)

    let countA = 0
    let countB = 0
    const handlerA = withIdempotency('handler-A', async (_event) => { countA++ }, { repo, logger })
    const handlerB = withIdempotency('handler-B', async (_event) => { countB++ }, { repo, logger })

    const event = makeEvent('shared-evt')
    await handlerA(event)
    await handlerB(event)
    // A second call should be deduped per handler
    await handlerA(event)
    await handlerB(event)

    expect(countA).toBe(1)
    expect(countB).toBe(1)
  })

  it('event bus + idempotent handler: re-publishing same event only processes once', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const logger = createLogger({ pretty: false, level: 'error' })
    const eventBus = new InProcessEventBus({ logger })
    const repo = createProcessedEventRepository(documentStore)

    let processed = 0
    const idempotentHandler = withIdempotency(
      'bus-handler',
      async (_event) => { processed++ },
      { repo, logger },
    )
    await eventBus.subscribe('test.idempotent.v1', idempotentHandler)

    const event = makeEvent('bus-evt-001', 'test.idempotent.v1')
    await eventBus.publish(event)
    await eventBus.publish(event)
    await new Promise((r) => setTimeout(r, 20))

    expect(processed).toBe(1)
    await eventBus.close()
  })
})
