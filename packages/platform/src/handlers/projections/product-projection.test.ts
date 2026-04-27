import { describe, expect, it } from 'vitest'
import { EVT_CATEGORY_CREATED, EVT_PRODUCT_CREATED, EVT_PRODUCT_DELETED, type NymbalEvent } from '@nymbal/types'
import { InMemoryDocumentStore } from '../../document-store/in-memory.js'
import { InProcessEventBus } from '../../event-bus/in-process.js'
import { createLogger } from '../../logger.js'
import { registerCategoryProjection } from './category-projection.js'
import { registerProductProjection, type DenormalisedProduct } from './product-projection.js'

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

function makeProductEvent(categoryIds: string[] = ['cat-1']) {
  return makeEvent(EVT_PRODUCT_CREATED, {
    product: {
      id: 'p1',
      slug: 'widget',
      name: 'Widget',
      description: 'A widget',
      shortDescription: '',
      status: 'active' as const,
      type: 'simple' as const,
      seoTitle: '',
      seoDescription: '',
      media: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      categoryIds,
      variants: [
        {
          id: 'v1',
          productId: 'p1',
          sku: 'W1',
          name: 'Default',
          priceMinor: 2500,
          compareAtPriceMinor: null,
          weightGrams: null,
          dimensions: null,
          stock: 5,
          lowStockThreshold: 2,
          options: [],
          status: 'active' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  })
}

describe('product-projection', () => {
  it('writes denormalised product + category index on create', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    await registerProductProjection({ eventBus, documentStore, logger, storeId: 'test-store', currency: 'GBP' })

    await eventBus.publish(makeProductEvent())
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get<DenormalisedProduct>('products', 'widget')
    expect(doc).not.toBeNull()
    expect(doc!.slug).toBe('widget')
    expect(doc!.inStock).toBe(true)
    expect(doc!.variantCount).toBe(1)

    // Without a resolved category, no by-category entry is written
    const index = await documentStore.get('products-by-category', 'category:cat-1#product:widget')
    expect(index).toBeNull()
  })

  it('includes resolved category name and slug in read model', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })

    // Register both projections — category must be populated before product events fire
    await registerCategoryProjection({ eventBus, documentStore, logger, storeId: 'test-store' })
    await registerProductProjection({ eventBus, documentStore, logger, storeId: 'test-store', currency: 'GBP' })

    // Publish category first so it lands in the document store
    await eventBus.publish(
      makeEvent(EVT_CATEGORY_CREATED, {
        category: {
          id: 'cat-1',
          slug: 'widgets',
          name: 'Widgets',
          description: 'All widgets',
          parentId: null,
          position: 0,
          createdAt: new Date().toISOString(),
        },
      }),
    )

    // Now publish the product — projection should resolve category name/slug
    await eventBus.publish(makeProductEvent(['cat-1']))
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get<DenormalisedProduct>('products', 'widget')
    expect(doc).not.toBeNull()
    expect(doc!.categories).toHaveLength(1)
    expect(doc!.categories[0]).toMatchObject({ id: 'cat-1', name: 'Widgets', slug: 'widgets' })

    // by-category index uses slug as partition key (matches URL ?category=widgets)
    const index = await documentStore.get('products-by-category', 'category:widgets#product:widget')
    expect(index).not.toBeNull()
  })

  it('categories is empty array when no matching category docs exist', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    await registerProductProjection({ eventBus, documentStore, logger, storeId: 'test-store', currency: 'GBP' })

    await eventBus.publish(makeProductEvent(['unknown-cat']))
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get<DenormalisedProduct>('products', 'widget')
    expect(doc!.categories).toEqual([])
  })

  it('removes documents on delete using slug-keyed by-category entries', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    // Projection now keys by-category with slug, so use a slug key here
    await documentStore.put('products', 'gone', {
      categoryIds: ['cat-x'],
      categories: [{ id: 'cat-x', name: 'X', slug: 'x-things' }],
    })
    await documentStore.put('products-by-category', 'category:x-things#product:gone', {})
    await registerProductProjection({ eventBus, documentStore, logger, storeId: 'test', currency: 'GBP' })
    await eventBus.publish(makeEvent(EVT_PRODUCT_DELETED, { productId: 'p', slug: 'gone' }))
    await new Promise((r) => setImmediate(r))
    expect(await documentStore.get('products', 'gone')).toBeNull()
    expect(await documentStore.get('products-by-category', 'category:x-things#product:gone')).toBeNull()
  })
})
