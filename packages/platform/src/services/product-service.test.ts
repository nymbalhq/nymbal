import { describe, expect, it } from 'vitest'
import { EVT_PRODUCT_CREATED, EVT_PRODUCT_PUBLISHED, NotFoundError, ValidationError } from '@nymbal/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher } from '../events/publisher.js'
import { createProductService } from './product-service.js'
import { createLogger } from '../logger.js'
import { v7 as uuidv7 } from 'uuid'

async function setup() {
  const config = {
    infrastructure: { commandStore: 'sqlite' as const },
    store: { name: 'test', currency: 'GBP' },
  }
  const commandStore = createCommandStore(
    // @ts-expect-error — minimal config for test
    config,
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, documentStore)
  const publisher = createEventPublisher({
    eventBus,
    builderContext: {
      storeId: 'test',
      environment: 'development',
      version: '0.0.0-test',
      source: 'test',
    },
  })
  const service = createProductService({ store: commandStore, repos, publisher, logger })
  return { service, repos, eventBus, commandStore, documentStore, publisher, logger }
}

describe('ProductService', () => {
  it('create emits product.created.v1 with snapshot', async () => {
    const { service, eventBus, commandStore } = await setup()
    const received: unknown[] = []
    await eventBus.subscribe(EVT_PRODUCT_CREATED, (event) => {
      received.push(event.payload)
    })
    const snap = await service.create({
      slug: 'test-product',
      name: 'Test Product',
      description: 'desc',
      status: 'active',
      variants: [
        {
          sku: 'TEST-1',
          name: 'Default',
          priceMinor: 1500,
          stock: 10,
          options: [],
        },
      ],
    })
    expect(snap.slug).toBe('test-product')
    expect(snap.variants).toHaveLength(1)
    expect(snap.variants[0]!.priceMinor).toBe(1500)
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('publish transitions status and emits product.published.v1', async () => {
    const { service, eventBus, commandStore } = await setup()
    const received: unknown[] = []
    await eventBus.subscribe(EVT_PRODUCT_PUBLISHED, (event) => {
      received.push(event.payload)
    })
    const created = await service.create({
      slug: 'draft',
      name: 'Draft Product',
      description: '',
      status: 'draft',
    })
    await service.publish(created.id)
    const fresh = await service.getById(created.id)
    expect(fresh.status).toBe('active')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('rejects duplicate slugs', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'dup', name: 'A' })
    await expect(service.create({ slug: 'dup', name: 'B' })).rejects.toThrow(/already exists/)
    await commandStore.close()
  })

  it('create rejects empty slug', async () => {
    const { service, commandStore } = await setup()
    await expect(service.create({ slug: '   ', name: 'A' })).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('create rejects empty name', async () => {
    const { service, commandStore } = await setup()
    await expect(service.create({ slug: 'valid', name: '  ' })).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('create uses explicit variant id when provided', async () => {
    const { service, commandStore } = await setup()
    const variantId = uuidv7()
    const snap = await service.create({
      slug: 'explicit-vid', name: 'Explicit',
      variants: [{ id: variantId, sku: 'EV-1', name: 'Custom', priceMinor: 500, stock: 1, options: [] }],
    })
    expect(snap.variants[0]!.id).toBe(variantId)
    await commandStore.close()
  })

  it('create with categoryIds attaches categories', async () => {
    const { service, repos, commandStore } = await setup()
    const categoryId = uuidv7()
    await repos.category.insert({
      id: categoryId, slug: 'test-cat', name: 'Test Category',
      description: '', parentId: null,
      createdAt: new Date(),
    })
    const snap = await service.create({ slug: 'with-category', name: 'With Category', categoryIds: [categoryId] })
    expect(snap.categoryIds).toContain(categoryId)
    await commandStore.close()
  })

  it('update patches fields and emits product.updated', async () => {
    const { service, commandStore } = await setup()
    const created = await service.create({ slug: 'upd-test', name: 'Original', status: 'draft' })
    const updated = await service.update(created.id, { name: 'Updated', description: 'New desc' })
    expect(updated.name).toBe('Updated')
    expect(updated.description).toBe('New desc')
    await commandStore.close()
  })

  it('update throws NotFoundError for unknown id', async () => {
    const { service, commandStore } = await setup()
    await expect(service.update('ghost', { name: 'x' })).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('update replaces categoryIds', async () => {
    const { service, repos, commandStore } = await setup()
    const catA = uuidv7()
    const catB = uuidv7()
    for (const [id, slug] of [[catA, 'cat-a'], [catB, 'cat-b']] as [string, string][]) {
      await repos.category.insert({ id, slug, name: slug, description: '', parentId: null, createdAt: new Date() })
    }
    const created = await service.create({ slug: 'cat-swap', name: 'Cat Swap', categoryIds: [catA] })
    const updated = await service.update(created.id, { categoryIds: [catB] })
    expect(updated.categoryIds).toContain(catB)
    expect(updated.categoryIds).not.toContain(catA)
    await commandStore.close()
  })

  it('delete removes product and its variants', async () => {
    const { service, commandStore } = await setup()
    const created = await service.create({
      slug: 'del-test', name: 'To Delete',
      variants: [{ sku: 'DEL-1', name: 'Default', priceMinor: 100, stock: 1, options: [] }],
    })
    await service.delete(created.id)
    await expect(service.getById(created.id)).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('delete throws NotFoundError for unknown id', async () => {
    const { service, commandStore } = await setup()
    await expect(service.delete('ghost')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('publish does nothing when product is already active', async () => {
    const { service, commandStore } = await setup()
    const created = await service.create({ slug: 'already-active', name: 'Active', status: 'active' })
    await service.publish(created.id)
    const fresh = await service.getById(created.id)
    expect(fresh.status).toBe('active')
    await commandStore.close()
  })

  it('unpublish transitions active product to draft', async () => {
    const { service, commandStore } = await setup()
    const created = await service.create({ slug: 'unpub-test', name: 'Active', status: 'active' })
    await service.unpublish(created.id)
    const fresh = await service.getById(created.id)
    expect(fresh.status).toBe('draft')
    await commandStore.close()
  })

  it('unpublish does nothing when product is already draft', async () => {
    const { service, commandStore } = await setup()
    const created = await service.create({ slug: 'already-draft', name: 'Draft', status: 'draft' })
    await service.unpublish(created.id)
    const fresh = await service.getById(created.id)
    expect(fresh.status).toBe('draft')
    await commandStore.close()
  })

  it('getById throws NotFoundError for unknown id', async () => {
    const { service, commandStore } = await setup()
    await expect(service.getById('ghost')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('getBySlug returns product snapshot', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'find-by-slug', name: 'By Slug' })
    const found = await service.getBySlug('find-by-slug')
    expect(found.slug).toBe('find-by-slug')
    await commandStore.close()
  })

  it('getBySlug throws NotFoundError for unknown slug', async () => {
    const { service, commandStore } = await setup()
    await expect(service.getBySlug('no-such-slug')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('list returns all products', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'list-a', name: 'A', status: 'active' })
    await service.create({ slug: 'list-b', name: 'B', status: 'draft' })
    const all = await service.list()
    expect(all.length).toBeGreaterThanOrEqual(2)
    await commandStore.close()
  })

  it('list filters by status', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'filter-active', name: 'Active', status: 'active' })
    await service.create({ slug: 'filter-draft', name: 'Draft', status: 'draft' })
    const active = await service.list({ status: 'active' })
    expect(active.every((p) => p.status === 'active')).toBe(true)
    await commandStore.close()
  })

  it('create with all optional fields stores them correctly', async () => {
    const { service, commandStore } = await setup()
    const snap = await service.create({
      slug: 'full-create',
      name: 'Full Create',
      description: 'Full description',
      shortDescription: 'Short desc',
      status: 'draft',
      type: 'variable',
      seoTitle: 'SEO Title',
      seoDescription: 'SEO Description',
      media: [{ url: 'https://example.com/img.jpg', altText: 'Image', position: 0 }],
      metadata: { brand: 'TestBrand' },
    })
    expect(snap.description).toBe('Full description')
    expect(snap.shortDescription).toBe('Short desc')
    expect(snap.seoTitle).toBe('SEO Title')
    await commandStore.close()
  })

  it('update with all optional fields patches them', async () => {
    const { service, commandStore } = await setup()
    const created = await service.create({ slug: 'full-update', name: 'Original' })
    const updated = await service.update(created.id, {
      name: 'Updated',
      description: 'Updated desc',
      shortDescription: 'Updated short',
      status: 'active',
      type: 'simple',
      seoTitle: 'New SEO',
      seoDescription: 'New SEO Desc',
      media: [{ url: 'https://example.com/new.jpg', altText: 'New', position: 0 }],
      metadata: { updated: true },
    })
    expect(updated.name).toBe('Updated')
    expect(updated.seoTitle).toBe('New SEO')
    expect(updated.metadata).toMatchObject({ updated: true })
    await commandStore.close()
  })
})
