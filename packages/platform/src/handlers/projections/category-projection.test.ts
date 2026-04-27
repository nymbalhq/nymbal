import { describe, expect, it } from 'vitest'
import { EVT_CATEGORY_CREATED, EVT_CATEGORY_DELETED, EVT_CATEGORY_UPDATED, type NymbalEvent } from '@nymbal/types'
import { InMemoryDocumentStore } from '../../document-store/in-memory.js'
import { InProcessEventBus } from '../../event-bus/in-process.js'
import { createLogger } from '../../logger.js'
import { registerCategoryProjection } from './category-projection.js'
import type { Category } from '@nymbal/types'

const logger = createLogger({ pretty: false, level: 'error' })

function makeEvent<T>(type: string, payload: T): NymbalEvent<T> {
  return {
    id: 'evt-1',
    type,
    timestamp: new Date().toISOString(),
    source: 'test',
    correlationId: 'corr-1',
    payload,
    metadata: { storeId: 'test', environment: 'development', version: '0.0.0' },
  }
}

const sampleCategory: Category = {
  id: 'cat-1',
  parentId: null,
  slug: 'apparel',
  name: 'Apparel',
  description: 'Clothing and accessories',
  position: 0,
  createdAt: new Date().toISOString(),
}

describe('category-projection', () => {
  it('writes category to document store on create, including parentId', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    await registerCategoryProjection({ eventBus, documentStore, logger, storeId: 'test-store' })

    await eventBus.publish(makeEvent(EVT_CATEGORY_CREATED, { category: sampleCategory }))
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get<Category & { storeId: string }>('categories', 'apparel')
    expect(doc).not.toBeNull()
    expect(doc!.id).toBe('cat-1')
    expect(doc!.slug).toBe('apparel')
    expect(doc!.name).toBe('Apparel')
    expect(doc!.parentId).toBeNull()
    expect(doc!.storeId).toBe('test-store')
  })

  it('stores parentId when category has a parent', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    await registerCategoryProjection({ eventBus, documentStore, logger, storeId: 'test-store' })

    const child: Category = { ...sampleCategory, id: 'cat-2', slug: 'mens-apparel', name: 'Mens', parentId: 'cat-1' }
    await eventBus.publish(makeEvent(EVT_CATEGORY_CREATED, { category: child }))
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get<{ parentId: string | null }>('categories', 'mens-apparel')
    expect(doc!.parentId).toBe('cat-1')
  })

  it('updates category on updated event', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    await registerCategoryProjection({ eventBus, documentStore, logger, storeId: 'test-store' })

    await eventBus.publish(makeEvent(EVT_CATEGORY_CREATED, { category: sampleCategory }))
    await new Promise((r) => setImmediate(r))

    const updated: Category = { ...sampleCategory, name: 'Apparel & Fashion' }
    await eventBus.publish(makeEvent(EVT_CATEGORY_UPDATED, { category: updated }))
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get<{ name: string }>('categories', 'apparel')
    expect(doc!.name).toBe('Apparel & Fashion')
  })

  it('is idempotent — processing the same event twice produces one document', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    await registerCategoryProjection({ eventBus, documentStore, logger, storeId: 'test-store' })

    const event = makeEvent(EVT_CATEGORY_CREATED, { category: sampleCategory })
    await eventBus.publish(event)
    await eventBus.publish(event)
    await new Promise((r) => setImmediate(r))

    const result = await documentStore.query<{ id: string }>('categories', {
      partitionKey: { field: 'storeId', value: 'test-store' },
      limit: 100,
    })
    expect(result.items.filter((c) => c.id === 'cat-1')).toHaveLength(1)
  })

  it('removes category from document store on delete', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    await registerCategoryProjection({ eventBus, documentStore, logger, storeId: 'test-store' })

    await eventBus.publish(makeEvent(EVT_CATEGORY_CREATED, { category: sampleCategory }))
    await new Promise((r) => setImmediate(r))

    await eventBus.publish(makeEvent(EVT_CATEGORY_DELETED, { categoryId: 'cat-1', slug: 'apparel' }))
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get('categories', 'apparel')
    expect(doc).toBeNull()
  })
})
