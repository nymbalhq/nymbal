import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import {
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_PUBLISHED,
  EVT_PRODUCT_UPDATED,
  EVT_PRODUCT_VARIANT_PRICE_CHANGED,
  HttpError,
  NotFoundError,
  ValidationError,
  type Variant,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createProductService } from './product-service.js'
import { createLogger } from '../logger.js'
import { runAsActor } from '../audit/actor.js'
import { auditedCommand } from '../audit/audit.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import type { CommandStore } from '../db/command-store.js'
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
  const { publisher, relay } = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  )
  const service = createProductService({
    store: commandStore,
    repos,
    publisher,
    logger,
    currency: 'GBP',
  })
  return { service, repos, eventBus, commandStore, documentStore, publisher, logger, relay }
}

describe('ProductService', () => {
  it('create emits product.created.v1 with snapshot', async () => {
    const { service, eventBus, commandStore, relay } = await setup()
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
    await relay.drain()
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('publish transitions status and emits product.published.v1', async () => {
    const { service, eventBus, commandStore, relay } = await setup()
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
    await relay.drain()
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
      slug: 'explicit-vid',
      name: 'Explicit',
      variants: [
        { id: variantId, sku: 'EV-1', name: 'Custom', priceMinor: 500, stock: 1, options: [] },
      ],
    })
    expect(snap.variants[0]!.id).toBe(variantId)
    await commandStore.close()
  })

  it('create with categoryIds attaches categories', async () => {
    const { service, repos, commandStore } = await setup()
    const categoryId = uuidv7()
    await commandStore.transaction((tx) =>
      repos.category.insert(tx, {
        id: categoryId,
        slug: 'test-cat',
        name: 'Test Category',
        description: '',
        parentId: null,
        createdAt: new Date(),
      }),
    )
    const snap = await service.create({
      slug: 'with-category',
      name: 'With Category',
      categoryIds: [categoryId],
    })
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
    for (const [id, slug] of [
      [catA, 'cat-a'],
      [catB, 'cat-b'],
    ] as [string, string][]) {
      await commandStore.transaction((tx) =>
        repos.category.insert(tx, {
          id,
          slug,
          name: slug,
          description: '',
          parentId: null,
          createdAt: new Date(),
        }),
      )
    }
    const created = await service.create({
      slug: 'cat-swap',
      name: 'Cat Swap',
      categoryIds: [catA],
    })
    const updated = await service.update(created.id, { categoryIds: [catB] })
    expect(updated.categoryIds).toContain(catB)
    expect(updated.categoryIds).not.toContain(catA)
    await commandStore.close()
  })

  it('delete removes product and its variants', async () => {
    const { service, commandStore } = await setup()
    const created = await service.create({
      slug: 'del-test',
      name: 'To Delete',
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
    const created = await service.create({
      slug: 'already-active',
      name: 'Active',
      status: 'active',
    })
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

describe('ProductService.update: variant prices', () => {
  async function priced() {
    const ctx = await setup()
    const created = await ctx.service.create({
      slug: 'priced',
      name: 'Priced',
      variants: [
        { sku: 'P-1', name: 'One', priceMinor: 1000, compareAtPriceMinor: 1500, stock: 1, options: [] },
        { sku: 'P-2', name: 'Two', priceMinor: 2000, compareAtPriceMinor: 2500, stock: 1, options: [] },
      ],
    })
    const [one, two] = created.variants as [Variant, Variant]
    const events: Array<{ type: string; payload: unknown }> = []
    await ctx.eventBus.subscribe([EVT_PRODUCT_VARIANT_PRICE_CHANGED, EVT_PRODUCT_UPDATED], (event) => {
      events.push({ type: event.type, payload: event.payload })
    })
    const stored = async () =>
      (await ctx.service.getById(created.id)).variants.map((v) => ({
        id: v.id,
        priceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor,
      }))
    return { ...ctx, created, one, two, events, stored }
  }

  it('an unknown variant id rejects with 400 product.variant_unknown and writes nothing', async () => {
    const { service, commandStore, created, one, events, stored, relay } = await priced()
    const before = await stored()
    const refusal = await service
      .update(created.id, {
        name: 'Renamed',
        variants: [
          { id: one.id, priceMinor: 900 },
          { id: 'not-a-variant', priceMinor: 1 },
        ],
      })
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(HttpError)
    expect(refusal).toMatchObject({ status: 400, code: 'product.variant_unknown' })
    expect(await stored()).toEqual(before)
    expect((await service.getById(created.id)).name).toBe(created.name)
    await relay.drain()
    expect(events).toEqual([])
    await commandStore.close()
  })

  it('a changed price is written and publishes one price event with both prices and the currency, before product.updated', async () => {
    const { service, commandStore, created, one, two, events, stored, relay } = await priced()
    const snap = await service.update(created.id, {
      variants: [
        { id: one.id, priceMinor: one.priceMinor - 200 },
        { id: two.id, priceMinor: two.priceMinor },
      ],
    })
    const expected = [
      { id: one.id, priceMinor: one.priceMinor - 200, compareAtPriceMinor: one.compareAtPriceMinor },
      { id: two.id, priceMinor: two.priceMinor, compareAtPriceMinor: two.compareAtPriceMinor },
    ]
    expect(await stored()).toEqual(expected)
    expect(
      snap.variants.map((v) => ({
        id: v.id,
        priceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor,
      })),
    ).toEqual(expected)
    await relay.drain()
    expect(events).toEqual([
      {
        type: EVT_PRODUCT_VARIANT_PRICE_CHANGED,
        payload: {
          productId: created.id,
          variantId: one.id,
          previousPriceMinor: one.priceMinor,
          priceMinor: one.priceMinor - 200,
          previousCompareAtPriceMinor: one.compareAtPriceMinor,
          compareAtPriceMinor: one.compareAtPriceMinor,
          currency: 'GBP',
        },
      },
      { type: EVT_PRODUCT_UPDATED, payload: { product: snap } },
    ])
    await commandStore.close()
  })

  it('unchanged prices publish no price event and leave the stored prices as they were', async () => {
    const { service, commandStore, created, one, two, events, stored, relay } = await priced()
    const before = await stored()
    await service.update(created.id, {
      variants: [
        { id: one.id, priceMinor: one.priceMinor },
        { id: two.id, priceMinor: two.priceMinor, compareAtPriceMinor: two.compareAtPriceMinor },
      ],
    })
    expect(await stored()).toEqual(before)
    await relay.drain()
    expect(events.map((e) => e.type)).toEqual([EVT_PRODUCT_UPDATED])
    await commandStore.close()
  })

  it('an omitted compareAtPriceMinor keeps the stored one, null clears it, and a compare-at change alone publishes', async () => {
    const { service, commandStore, created, one, two, events, stored, relay } = await priced()
    await service.update(created.id, {
      variants: [
        { id: one.id, priceMinor: one.priceMinor + 100 },
        { id: two.id, priceMinor: two.priceMinor, compareAtPriceMinor: null },
      ],
    })
    expect(await stored()).toEqual([
      { id: one.id, priceMinor: one.priceMinor + 100, compareAtPriceMinor: one.compareAtPriceMinor },
      { id: two.id, priceMinor: two.priceMinor, compareAtPriceMinor: null },
    ])
    await relay.drain()
    const priceEvents = events.filter((e) => e.type === EVT_PRODUCT_VARIANT_PRICE_CHANGED)
    expect(priceEvents.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        variantId: one.id,
        previousCompareAtPriceMinor: one.compareAtPriceMinor,
        compareAtPriceMinor: one.compareAtPriceMinor,
      }),
      expect.objectContaining({
        variantId: two.id,
        previousPriceMinor: two.priceMinor,
        priceMinor: two.priceMinor,
        previousCompareAtPriceMinor: two.compareAtPriceMinor,
        compareAtPriceMinor: null,
      }),
    ])
    expect(events.at(-1)?.type).toBe(EVT_PRODUCT_UPDATED)
    expect(events).toHaveLength(priceEvents.length + 1)
    await commandStore.close()
  })
})

// A service notes the command it runs and the records it touches into the open command, and writes no row itself.
// Under an actor with no opener (an import), each transaction a service notes in is a command of its own.
const importer = { kind: 'import', id: 'woocommerce' } as const
const admin = { kind: 'admin', id: 'admin-1' } as const

const noted = async (commandStore: CommandStore) =>
  (await commandStore.read((tx) => listAuditEntries(tx, { order: 'asc', limit: 100 }))).map(
    (e) => ({
      actor: e.actor,
      command: e.command,
      subjects: e.subjects,
      outcome: e.outcome,
      status: e.responseStatus,
    }),
  )

describe('ProductService: audit notes', () => {
  it('AC-2: under an actor with no opener, create, update, publish, unpublish and delete each leave one applied entry naming the product', async () => {
    const { service, commandStore } = await setup()
    const created = await runAsActor(importer, () =>
      service.create({ slug: 'audited', name: 'Audited', status: 'draft' }),
    )
    await runAsActor(importer, () => service.update(created.id, { name: 'Renamed' }))
    await runAsActor(importer, () => service.publish(created.id))
    await runAsActor(importer, () => service.unpublish(created.id))
    await runAsActor(importer, () => service.delete(created.id))
    const subjects = [{ type: 'product', id: created.id }]
    expect(await noted(commandStore)).toEqual([
      { actor: importer, command: 'product.create', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'product.update', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'product.publish', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'product.unpublish', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'product.delete', subjects, outcome: 'applied', status: null },
    ])
    await commandStore.close()
  })

  it('AC-2: a create refused before its transaction is recorded as product.create refused; with no actor nothing is recorded', async () => {
    const { service, commandStore } = await setup()
    await expect(
      runAsActor(admin, () =>
        auditedCommand(commandStore, undefined, () => service.create({ slug: '', name: 'Blank' })),
      ),
    ).rejects.toThrow(ValidationError)
    await service.create({ slug: 'unscoped', name: 'No actor' })
    expect(await noted(commandStore)).toEqual([
      { actor: admin, command: 'product.create', subjects: [], outcome: 'refused', status: 400 },
    ])
    await commandStore.close()
  })
})

describe('ProductService.duplicate', () => {
  async function withOriginal() {
    const ctx = await setup()
    const original = await ctx.service.create({
      slug: 'mug',
      name: 'Mug',
      description: 'A mug',
      shortDescription: 'Mug short',
      status: 'active',
      type: 'variable',
      seoTitle: 'Mug SEO',
      seoDescription: 'Mug SEO desc',
      media: [{ url: 'https://example.com/mug.jpg', altText: 'Mug', position: 0 }],
      metadata: { brand: 'Acme' },
      variants: [
        {
          sku: 'MUG-S',
          name: 'Small',
          priceMinor: 800,
          compareAtPriceMinor: 1000,
          weightGrams: 300,
          stock: 7,
          lowStockThreshold: 2,
          options: [{ name: 'Size', value: 'S' }],
          taxCode: 'reduced',
        },
        {
          sku: 'MUG-L',
          name: 'Large',
          priceMinor: 1200,
          stock: 4,
          options: [{ name: 'Size', value: 'L' }],
          taxCode: 'standard',
        },
      ],
    })
    return { ...ctx, original }
  }

  it('copies as a draft named "(Copy)" under -copy slugs and SKUs, every variant at stock 0 with its prices and tax code', async () => {
    const { service, commandStore, original } = await withOriginal()
    const copy = await service.duplicate(original.id)
    expect(copy.id).not.toBe(original.id)
    expect(copy.slug).toBe('mug-copy')
    expect(copy.name).toBe('Mug (Copy)')
    expect(copy.status).toBe('draft')
    expect(copy).toMatchObject({
      description: 'A mug',
      shortDescription: 'Mug short',
      type: 'variable',
      seoTitle: 'Mug SEO',
      seoDescription: 'Mug SEO desc',
      metadata: { brand: 'Acme' },
    })
    const bySku = new Map(copy.variants.map((v) => [v.sku, v]))
    expect([...bySku.keys()].sort()).toEqual(['MUG-L-COPY', 'MUG-S-COPY'])
    for (const v of copy.variants) expect(v.stock).toBe(0)
    expect(bySku.get('MUG-S-COPY')).toMatchObject({
      name: 'Small',
      priceMinor: 800,
      compareAtPriceMinor: 1000,
      weightGrams: 300,
      lowStockThreshold: 2,
      options: [{ name: 'Size', value: 'S' }],
      taxCode: 'reduced',
    })
    expect(bySku.get('MUG-L-COPY')).toMatchObject({ priceMinor: 1200, taxCode: 'standard' })
    const stored = await service.getById(copy.id)
    expect(stored.variants.map((v) => v.stock)).toEqual([0, 0])
    await commandStore.close()
  })

  it('leaves the original unchanged', async () => {
    const { service, commandStore, original } = await withOriginal()
    await service.duplicate(original.id)
    const after = await service.getById(original.id)
    expect(after).toEqual(original)
    await commandStore.close()
  })

  it('a taken slug moves the copy to the first free -copy-<k> for slug and SKUs alike', async () => {
    const { service, commandStore, original } = await withOriginal()
    await service.create({ slug: 'mug-copy', name: 'Taken' })
    await service.create({ slug: 'mug-copy-2', name: 'Taken too' })
    const copy = await service.duplicate(original.id)
    expect(copy.slug).toBe('mug-copy-3')
    expect(copy.variants.map((v) => v.sku).sort()).toEqual(['MUG-L-COPY-3', 'MUG-S-COPY-3'])
    await commandStore.close()
  })

  it('a taken SKU alone, on any variant, moves the copy to the next free suffix', async () => {
    const { service, commandStore, original } = await withOriginal()
    await service.create({
      slug: 'other',
      name: 'Other',
      variants: [{ sku: 'MUG-L-COPY', name: 'Squatter', priceMinor: 1, stock: 0, options: [] }],
    })
    const copy = await service.duplicate(original.id)
    expect(copy.slug).toBe('mug-copy-2')
    expect(copy.variants.map((v) => v.sku).sort()).toEqual(['MUG-L-COPY-2', 'MUG-S-COPY-2'])
    await commandStore.close()
  })

  it('successive copies take successive suffixes', async () => {
    const { service, commandStore, original } = await withOriginal()
    const first = await service.duplicate(original.id)
    const second = await service.duplicate(original.id)
    expect([first.slug, second.slug]).toEqual(['mug-copy', 'mug-copy-2'])
    await commandStore.close()
  })

  it('an unknown id rejects with NotFoundError and creates nothing', async () => {
    const { service, commandStore } = await setup()
    await expect(service.duplicate(uuidv7())).rejects.toThrow(NotFoundError)
    expect(await service.list()).toEqual([])
    await commandStore.close()
  })
})

// A product's brand and each variant's GTIN. A GTIN rides on the variants entry of an update beside its prices: omitted
// it keeps the stored one, null or '' clears it, and a GTIN change is no price change. A variant is written only when
// its price or GTIN really changes, which its updatedAt shows (the clock is moved between commands).
describe('ProductService: brand and GTIN', () => {
  const GTIN_A = '4006381333931'
  const GTIN_B = '036000291452'
  const T0 = Date.parse('2026-11-01T10:00:00.000Z')

  interface Seen {
    type: string
    payload: Record<string, unknown>
  }

  async function withIdentifiers() {
    const ctx = await setup()
    const seen: Seen[] = []
    await ctx.eventBus.subscribe(
      [EVT_PRODUCT_VARIANT_PRICE_CHANGED, EVT_PRODUCT_UPDATED],
      (event) => {
        seen.push({ type: event.type, payload: event.payload as Record<string, unknown> })
      },
    )
    /** The events a step published, once delivered; `seen` is emptied for the next step. */
    const drained = async (): Promise<Seen[]> => {
      await ctx.relay.drain()
      return seen.splice(0)
    }
    return { ...ctx, drained }
  }

  const priceEvents = (events: Seen[]) =>
    events.filter((e) => e.type === EVT_PRODUCT_VARIANT_PRICE_CHANGED)
  const updatedSnapshots = (events: Seen[]) =>
    events
      .filter((e) => e.type === EVT_PRODUCT_UPDATED)
      .map((e) => e.payload['product'] as { variants: Variant[]; brand?: string })

  it("AC-2: a create stores the brand and each variant's GTIN, and a variant created with gtin '' answers and stores gtin null", async () => {
    const { service, commandStore } = await setup()
    const snap = await service.create({
      slug: 'branded',
      name: 'Branded',
      brand: 'Acme',
      variants: [
        { sku: 'B-1', name: 'One', priceMinor: 1000, stock: 1, options: [], gtin: GTIN_A },
        { sku: 'B-2', name: 'Two', priceMinor: 1000, stock: 1, options: [], gtin: '' },
      ],
    })
    const stored = await service.getById(snap.id)
    const gtins = (variants: Variant[]) => variants.map((v) => [v.sku, v.gtin])

    expect([snap.brand, stored.brand]).toEqual(['Acme', 'Acme'])
    expect(gtins(snap.variants)).toEqual([
      ['B-1', GTIN_A],
      ['B-2', null],
    ])
    expect(gtins(stored.variants)).toEqual(gtins(snap.variants))
    await commandStore.close()
  })

  it('AC-2: an entry changing both price and GTIN stores both and publishes exactly one price event, whose prices are the old and new price', async () => {
    const { service, commandStore, drained } = await withIdentifiers()
    const created = await service.create({
      slug: 'both',
      name: 'Both',
      variants: [
        { sku: 'BOTH-1', name: 'One', priceMinor: 1000, stock: 1, options: [], gtin: GTIN_A },
      ],
    })
    const [one] = created.variants as [Variant]
    await drained()

    await service.update(created.id, { variants: [{ id: one.id, priceMinor: 800, gtin: GTIN_B }] })
    const stored = (await service.getById(created.id)).variants[0]!
    const events = await drained()

    expect([stored.priceMinor, stored.gtin]).toEqual([800, GTIN_B])
    expect(
      priceEvents(events).map((e) => [
        e.payload['variantId'],
        e.payload['previousPriceMinor'],
        e.payload['priceMinor'],
      ]),
    ).toEqual([[one.id, one.priceMinor, 800]])
    expect(updatedSnapshots(events).map((p) => p.variants.map((v) => v.gtin))).toEqual([[GTIN_B]])
    await commandStore.close()
  })

  it('AC-2: property: over sequences of entries (price kept or changed; gtin omitted, null, empty or set), the stored GTIN is the last one set and cleared by null or empty, a variant is written exactly when its price or GTIN changes, one price event is published per price change and none per GTIN change, and the one product.updated carries the stored GTINs', async () => {
    const { service, commandStore, drained } = await withIdentifiers()
    let made = 0

    const gtinArb = fc.constantFrom<string | null | undefined>(undefined, null, '', GTIN_A, GTIN_B)
    const entryArb = fc.record({
      at: fc.integer({ min: 0, max: 1 }),
      reprice: fc.boolean(),
      gtin: gtinArb,
    })
    type Entry = { at: number; reprice: boolean; gtin: string | null | undefined }

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.array(entryArb, { minLength: 1, maxLength: 2 }), {
            minLength: 1,
            maxLength: 4,
          }),
          async (edits: Entry[][]) => {
            let clock = T0
            vi.setSystemTime(clock)
            made += 1
            const created = await service.create({
              slug: `seq-${made}`,
              name: `Sequence ${made}`,
              variants: [
                {
                  sku: `SEQ-${made}-0`,
                  name: 'Zero',
                  priceMinor: 1000,
                  stock: 1,
                  options: [],
                  gtin: '',
                },
                {
                  sku: `SEQ-${made}-1`,
                  name: 'One',
                  priceMinor: 2000,
                  stock: 1,
                  options: [],
                  gtin: GTIN_A,
                },
              ],
            })
            const ids = created.variants.map((v) => v.id)
            let model = created.variants.map((v) => ({
              priceMinor: v.priceMinor,
              gtin: v.gtin ?? null,
              updatedAt: Date.parse(v.updatedAt),
            }))
            expect(
              model.map((m) => m.gtin),
              'as created',
            ).toEqual([null, GTIN_A])
            await drained()

            for (const raw of edits) {
              const seenAt = new Set<number>()
              const entries = raw.filter((e) => !seenAt.has(e.at) && seenAt.add(e.at))
              clock += 60_000
              vi.setSystemTime(clock)
              const label = JSON.stringify(entries)

              await service.update(created.id, {
                variants: entries.map((e) => ({
                  id: ids[e.at]!,
                  priceMinor: model[e.at]!.priceMinor + (e.reprice ? 100 : 0),
                  ...(e.gtin !== undefined && { gtin: e.gtin }),
                })),
              })

              const next = model.map((m) => ({ ...m }))
              const repriced: string[] = []
              for (const e of entries) {
                const before = model[e.at]!
                const gtin = e.gtin === undefined ? before.gtin : e.gtin === '' ? null : e.gtin
                const priceMinor = before.priceMinor + (e.reprice ? 100 : 0)
                const written = gtin !== before.gtin || priceMinor !== before.priceMinor
                next[e.at] = { priceMinor, gtin, updatedAt: written ? clock : before.updatedAt }
                if (e.reprice) repriced.push(ids[e.at]!)
              }

              const stored = (await service.getById(created.id)).variants
              const byId = new Map(stored.map((v) => [v.id, v]))
              expect(
                ids.map((id) => {
                  const v = byId.get(id)!
                  return {
                    priceMinor: v.priceMinor,
                    gtin: v.gtin ?? null,
                    updatedAt: Date.parse(v.updatedAt),
                  }
                }),
                label,
              ).toEqual(next)

              const events = await drained()
              expect(
                priceEvents(events)
                  .map((e) => e.payload['variantId'])
                  .sort(),
                `${label}: the variants a price event names`,
              ).toEqual(repriced.sort())
              const snaps = updatedSnapshots(events)
              expect(snaps.length, `${label}: product.updated`).toBe(1)
              expect(
                ids.map((id) => snaps[0]!.variants.find((v) => v.id === id)?.gtin ?? null),
                `${label}: the GTINs product.updated carries`,
              ).toEqual(next.map((m) => m.gtin))
              model = next
            }
          },
        ),
        {
          numRuns: 40,
          examples: [
            [[[{ at: 0, reprice: false, gtin: '' }], [{ at: 1, reprice: false, gtin: GTIN_A }]]],
            [
              [
                [{ at: 1, reprice: false, gtin: GTIN_B }],
                [{ at: 1, reprice: false, gtin: undefined }],
              ],
            ],
            [[[{ at: 1, reprice: true, gtin: GTIN_B }], [{ at: 1, reprice: false, gtin: null }]]],
            [[[{ at: 1, reprice: true, gtin: undefined }], [{ at: 1, reprice: false, gtin: '' }]]],
          ],
        },
      )
    } finally {
      vi.useRealTimers()
    }
    await commandStore.close()
  })

  it('AC-2: an update with brand alone changes the brand, and no variant is written', async () => {
    const { service, commandStore, drained } = await withIdentifiers()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T0)
      const created = await service.create({
        slug: 'brand-only',
        name: 'Brand only',
        brand: 'Acme',
        variants: [
          { sku: 'BO-1', name: 'One', priceMinor: 1000, stock: 1, options: [], gtin: GTIN_A },
        ],
      })
      await drained()
      vi.setSystemTime(T0 + 60_000)
      await service.update(created.id, { brand: 'Northwind' })
      const after = await service.getById(created.id)

      expect([created.brand, after.brand]).toEqual(['Acme', 'Northwind'])
      expect(after.variants).toEqual(created.variants)
      expect(priceEvents(await drained())).toEqual([])
    } finally {
      vi.useRealTimers()
    }
    await commandStore.close()
  })

  it('AC-4: a copy keeps the brand and every variant of it has gtin null, in the answer and as stored; the original keeps its GTINs', async () => {
    const { service, commandStore } = await setup()
    const original = await service.create({
      slug: 'scanned',
      name: 'Scanned',
      brand: 'Acme',
      variants: [
        { sku: 'SC-1', name: 'One', priceMinor: 1000, stock: 3, options: [], gtin: GTIN_A },
        { sku: 'SC-2', name: 'Two', priceMinor: 1200, stock: 2, options: [], gtin: GTIN_B },
      ],
    })
    const copy = await service.duplicate(original.id)
    const stored = await service.getById(copy.id)
    const after = await service.getById(original.id)

    expect([original.brand, copy.brand, stored.brand]).toEqual(['Acme', 'Acme', 'Acme'])
    expect(copy.variants.map((v) => v.gtin)).toEqual(original.variants.map(() => null))
    expect(stored.variants.map((v) => v.gtin)).toEqual(original.variants.map(() => null))
    expect(after.variants.map((v) => v.gtin)).toEqual([GTIN_A, GTIN_B])
    await commandStore.close()
  })
})

describe('ProductService: a product’s tax code', () => {
  interface Seen {
    type: string
    product: { id: string; taxCode?: string | null }
  }

  /** setup(), with every product.created and product.updated delivered into `seen` once drained. */
  async function withEvents() {
    const ctx = await setup()
    const seen: Seen[] = []
    await ctx.eventBus.subscribe([EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED], (event) => {
      seen.push({
        type: event.type,
        product: (event.payload as { product: Seen['product'] }).product,
      })
    })
    /** The events a step published, once delivered; `seen` is emptied for the next step. */
    const drained = async (): Promise<Seen[]> => {
      await ctx.relay.drain()
      return seen.splice(0)
    }
    return { ...ctx, drained }
  }

  const codesOf = (events: Seen[]) => events.map((e) => [e.type, e.product.taxCode ?? null])

  // Kills: a create that drops the code, or a created event whose snapshot does not carry it.
  it('AC-3: create with a code stores it, and its one product.created.v1 carries it', async () => {
    const { service, commandStore, drained } = await withEvents()
    const created = await service.create({ slug: 'taxed', name: 'Taxed', taxCode: 'reduced' })
    const stored = await service.getById(created.id)

    expect([created.taxCode, stored.taxCode]).toEqual(['reduced', 'reduced'])
    expect(codesOf(await drained())).toEqual([[EVT_PRODUCT_CREATED, stored.taxCode]])
    await commandStore.close()
  })

  // Kills: a tax edit the event log and History never see; an update without the key that clears the code.
  it('AC-3: update(id, { taxCode }) publishes one product.updated.v1 whose snapshot carries the new code; update(id, { name }) leaves the code as it was', async () => {
    const { service, commandStore, drained } = await withEvents()
    const created = await service.create({ slug: 'retaxed', name: 'Retaxed', taxCode: 'reduced' })
    await drained()

    await service.update(created.id, { taxCode: 'zero' })
    const zero = await service.getById(created.id)
    const onCode = await drained()
    await service.update(created.id, { name: 'Renamed' })
    const renamed = await service.getById(created.id)
    const onName = await drained()

    expect([created.taxCode, zero.taxCode, renamed.taxCode]).toEqual(['reduced', 'zero', 'zero'])
    expect(codesOf(onCode)).toEqual([[EVT_PRODUCT_UPDATED, zero.taxCode]])
    expect(codesOf(onName)).toEqual([[EVT_PRODUCT_UPDATED, zero.taxCode]])
    expect(renamed.name).toBe('Renamed')
    await commandStore.close()
  })

  // Kills: an update that writes only a set code and never a clear, or rewrites the code when the key is absent.
  it('AC-3: property: over updates that omit taxCode, clear it with null or set it, the stored code and each product.updated snapshot’s code are the last one set, or null after a clear', async () => {
    type Step = { kind: 'omit' } | { kind: 'null' } | { kind: 'set'; code: string }
    const arbCode = fc.stringMatching(/^[a-z0-9_-]{1,64}$/)
    const arbStep: fc.Arbitrary<Step> = fc.oneof(
      fc.constant<Step>({ kind: 'omit' }),
      fc.constant<Step>({ kind: 'null' }),
      fc.record({ kind: fc.constant('set' as const), code: arbCode }),
    )
    const { service, commandStore, drained } = await withEvents()
    let n = 0
    await fc.assert(
      fc.asyncProperty(
        fc.option(arbCode, { nil: null }),
        fc.array(arbStep, { minLength: 1, maxLength: 6 }),
        async (initial, steps) => {
          n += 1
          const created = await service.create({
            slug: `prop-${n}`,
            name: `Prop ${n}`,
            ...(initial !== null && { taxCode: initial }),
          })
          await drained()
          let model: string | null = initial
          for (const [i, step] of steps.entries()) {
            if (step.kind === 'omit') await service.update(created.id, { description: `d${i}` })
            else if (step.kind === 'null') await service.update(created.id, { taxCode: null })
            else await service.update(created.id, { taxCode: step.code })
            if (step.kind === 'null') model = null
            if (step.kind === 'set') model = step.code
            const label = JSON.stringify(steps.slice(0, i + 1))
            expect((await service.getById(created.id)).taxCode ?? null, label).toBe(model)
            expect(codesOf(await drained()), label).toEqual([[EVT_PRODUCT_UPDATED, model]])
          }
        },
      ),
      { numRuns: 25 },
    )
    await commandStore.close()
  })

  // Kills: a copy that loses the product's tax treatment.
  it('AC-3: duplicate of a product with a code makes a copy with the same code, in the answer and as stored; a product with none copies none', async () => {
    const { service, commandStore } = await setup()
    const taxed = await service.create({ slug: 'coded', name: 'Coded', taxCode: 'reduced' })
    const untaxed = await service.create({ slug: 'uncoded', name: 'Uncoded' })

    const copy = await service.duplicate(taxed.id)
    const plainCopy = await service.duplicate(untaxed.id)
    const stored = await service.getById(copy.id)

    expect(taxed.taxCode).toBe('reduced')
    expect([copy.taxCode, stored.taxCode]).toEqual([taxed.taxCode, taxed.taxCode])
    expect(plainCopy.taxCode ?? null).toBe(untaxed.taxCode ?? null)
    await commandStore.close()
  })
})
