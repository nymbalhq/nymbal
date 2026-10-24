import { describe, expect, it } from 'vitest'
import {
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_DELETED,
  EVT_CATEGORY_UPDATED,
  type Category,
  type NymbalEvent,
} from '@nymbalhq/types'
import { createCommandStore } from '../../db/command-store.js'
import { runMigrations } from '../../db/migrate.js'
import { InMemoryDocumentStore } from '../../document-store/in-memory.js'
import { InProcessEventBus } from '../../event-bus/in-process.js'
import { createLogger } from '../../logger.js'
import { buildCategoryDoc } from '../../read-models/builders.js'
import { buildRepositories } from '../../repositories/index.js'
import type { CategoryInsert } from '../../repositories/category.js'
import { registerCategoryProjection } from './category-projection.js'

// The category projection builds from the category row the command store holds at handle time, never from the event
// payload, so each case inserts the row before it publishes the event.

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

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(store, documentStore)
  await registerCategoryProjection({
    eventBus,
    documentStore,
    logger,
    storeId: 'test-store',
    repos,
  })

  async function readRow(id: string): Promise<Category | null> {
    return store.read((tx) => repos.category.findById(tx, id))
  }
  async function insertRow(c: CategoryInsert): Promise<Category> {
    await store.transaction((tx) => repos.category.insert(tx, c))
    return (await readRow(c.id))!
  }
  return { store, documentStore, eventBus, repos, insertRow, readRow }
}

const apparel: CategoryInsert = {
  id: 'cat-1',
  parentId: null,
  slug: 'apparel',
  name: 'Apparel',
  description: 'Clothing and accessories',
  position: 0,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
}

describe('category-projection', () => {
  it('writes category to document store on create, including parentId', async () => {
    const env = await setup()
    const row = await env.insertRow(apparel)

    await env.eventBus.publish(makeEvent(EVT_CATEGORY_CREATED, { category: row }))

    const doc = await env.documentStore.get<Category & { storeId: string }>('categories', 'apparel')
    expect(doc).not.toBeNull()
    expect(doc!.id).toBe(row.id)
    expect(doc!.slug).toBe(row.slug)
    expect(doc!.name).toBe(row.name)
    expect(doc!.parentId).toBeNull()
    expect(doc!.storeId).toBe('test-store')
    await env.store.close()
  })

  it('stores parentId when category has a parent', async () => {
    const env = await setup()
    await env.insertRow(apparel)
    const child = await env.insertRow({
      ...apparel,
      id: 'cat-2',
      slug: 'mens-apparel',
      name: 'Mens',
      parentId: 'cat-1',
    })

    await env.eventBus.publish(makeEvent(EVT_CATEGORY_CREATED, { category: child }))

    const doc = await env.documentStore.get<{ parentId: string | null }>(
      'categories',
      'mens-apparel',
    )
    expect(doc!.parentId).toBe('cat-1')
    await env.store.close()
  })

  it('updates category on updated event', async () => {
    const env = await setup()
    const row = await env.insertRow(apparel)
    await env.eventBus.publish(makeEvent(EVT_CATEGORY_CREATED, { category: row }))

    await env.store.transaction((tx) =>
      env.repos.category.update(tx, 'cat-1', { name: 'Apparel & Fashion' }),
    )
    const updated = await env.readRow('cat-1')
    await env.eventBus.publish(makeEvent(EVT_CATEGORY_UPDATED, { category: updated! }))

    const doc = await env.documentStore.get<{ name: string }>('categories', 'apparel')
    expect(doc!.name).toBe('Apparel & Fashion')
    await env.store.close()
  })

  it('is idempotent: processing the same event twice produces one document', async () => {
    const env = await setup()
    const row = await env.insertRow(apparel)

    const event = makeEvent(EVT_CATEGORY_CREATED, { category: row })
    await env.eventBus.publish(event)
    await env.eventBus.publish(event)

    const result = await env.documentStore.query<{ id: string }>('categories', {
      partitionKey: { field: 'storeId', value: 'test-store' },
      limit: 100,
    })
    const rows = await env.store.read((tx) => env.repos.category.list(tx))
    expect(result.items.filter((c) => c.id === 'cat-1')).toHaveLength(1)
    expect(result.items.length).toBe(rows.length)
    await env.store.close()
  })

  it('removes category from document store on delete', async () => {
    const env = await setup()
    const row = await env.insertRow(apparel)
    await env.eventBus.publish(makeEvent(EVT_CATEGORY_CREATED, { category: row }))

    await env.store.transaction((tx) => env.repos.category.delete(tx, 'cat-1'))
    await env.eventBus.publish(
      makeEvent(EVT_CATEGORY_DELETED, { categoryId: 'cat-1', slug: 'apparel' }),
    )

    const doc = await env.documentStore.get('categories', 'apparel')
    expect(doc).toBeNull()
    await env.store.close()
  })

  it('AC-2: a stale payload (old name) yields the document of the row held at handle time', async () => {
    const env = await setup()
    const original = await env.insertRow(apparel)
    // The row has moved on since the event was recorded; a replay re-delivers the old payload.
    await env.store.transaction((tx) =>
      env.repos.category.update(tx, 'cat-1', { name: 'Apparel & Fashion' }),
    )
    const current = await env.readRow('cat-1')

    await env.eventBus.publish(makeEvent(EVT_CATEGORY_UPDATED, { category: original }))

    const doc = await env.documentStore.get('categories', 'apparel')
    expect(current!.name).not.toBe(original.name)
    expect(doc).toEqual(buildCategoryDoc(current!, 'test-store'))
    await env.store.close()
  })
})
