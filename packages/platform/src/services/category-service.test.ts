import { describe, expect, it } from 'vitest'
import {
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_UPDATED,
  EVT_CATEGORY_DELETED,
  NotFoundError,
  ValidationError,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createCategoryService } from './category-service.js'
import { createLogger } from '../logger.js'

async function setup() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, documentStore)
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
  const service = createCategoryService({ repos, publisher, logger })
  return { commandStore, eventBus, service }
}

describe('CategoryService', () => {
  it('list returns empty array initially', async () => {
    const { service, commandStore } = await setup()
    expect(await service.list()).toEqual([])
    await commandStore.close()
  })

  it('create returns category and emits category.created', async () => {
    const { service, eventBus, commandStore } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CATEGORY_CREATED, (e) => {
      events.push(e.payload)
    })
    const cat = await service.create({ slug: 'apparel', name: 'Apparel' })
    expect(cat.id).toBeTruthy()
    expect(cat.slug).toBe('apparel')
    expect(events).toHaveLength(1)
    await commandStore.close()
  })

  it('create throws ValidationError for empty slug', async () => {
    const { service, commandStore } = await setup()
    await expect(service.create({ slug: '   ', name: 'Bad' })).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('create throws ValidationError for duplicate slug', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'dup-slug', name: 'First' })
    await expect(service.create({ slug: 'dup-slug', name: 'Second' })).rejects.toThrow(
      ValidationError,
    )
    await commandStore.close()
  })

  it('getById returns created category', async () => {
    const { service, commandStore } = await setup()
    const created = await service.create({ slug: 'shoes', name: 'Shoes' })
    const found = await service.getById(created.id)
    // A round trip through the repository loses nothing the caller was handed.
    expect(found).toEqual(created)
    await commandStore.close()
  })

  it('getById throws NotFoundError for unknown id', async () => {
    const { service, commandStore } = await setup()
    await expect(service.getById('nope')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('getBySlug returns category', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'books', name: 'Books' })
    const found = await service.getBySlug('books')
    expect(found.name).toBe('Books')
    await commandStore.close()
  })

  it('getBySlug throws NotFoundError for unknown slug', async () => {
    const { service, commandStore } = await setup()
    await expect(service.getBySlug('ghost-slug')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('update patches name and emits category.updated', async () => {
    const { service, eventBus, commandStore } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CATEGORY_UPDATED, (e) => {
      events.push(e.payload)
    })
    const created = await service.create({
      slug: 'electro',
      name: 'Electronics',
      description: 'Gadgets',
      position: 3,
    })
    const updated = await service.update(created.id, { name: 'Consumer Electronics' })
    // A patch changes only the fields it names; the event carries the row the caller got back.
    expect(updated).toEqual({ ...created, name: 'Consumer Electronics' })
    expect(events).toEqual([{ category: updated }])
    await commandStore.close()
  })

  it('update throws NotFoundError for unknown id', async () => {
    const { service, commandStore } = await setup()
    await expect(service.update('nope', { name: 'X' })).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('delete removes category and emits category.deleted', async () => {
    const { service, eventBus, commandStore } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CATEGORY_DELETED, (e) => {
      events.push(e.payload)
    })
    const kept = await service.create({ slug: 'to-keep', name: 'Keep Me' })
    const created = await service.create({ slug: 'to-delete', name: 'Delete Me' })
    const before = await service.list()
    await service.delete(created.id)
    const after = await service.list()
    await expect(service.getById(created.id)).rejects.toThrow(NotFoundError)
    // Exactly one row goes, and it is the one named: a delete without its id filter empties the table.
    expect(after).toHaveLength(before.length - 1)
    expect(after.map((c) => c.id)).toEqual([kept.id])
    expect(events).toEqual([{ categoryId: created.id, slug: created.slug }])
    await commandStore.close()
  })

  it('delete throws NotFoundError for unknown id', async () => {
    const { service, commandStore } = await setup()
    await expect(service.delete('nope')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('list returns all created categories', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'c1', name: 'C1' })
    await service.create({ slug: 'c2', name: 'C2' })
    const list = await service.list()
    expect(list).toHaveLength(2)
    await commandStore.close()
  })
})
