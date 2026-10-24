import { describe, expect, it } from 'vitest'
import {
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_DELETED,
  type Category,
  type NymbalEvent,
  type ProductSnapshot,
} from '@nymbalhq/types'
import type { ReadTx } from '../../db/command-store.js'
import { InMemoryDocumentStore } from '../../document-store/in-memory.js'
import { InProcessEventBus } from '../../event-bus/in-process.js'
import { createLogger } from '../../logger.js'
import { buildProductDoc } from '../../read-models/builders.js'
import {
  registerProductProjection,
  type DenormalisedProduct,
  type ProductProjectionDeps,
} from './product-projection.js'

// The product projection builds from the rows the command store holds at handle time, so each case gives it those
// rows through an in-memory stand-in for the four catalogue repositories.

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

function makeProduct(categoryIds: string[] = ['cat-1']): ProductSnapshot {
  return {
    id: 'p1',
    slug: 'widget',
    name: 'Widget',
    description: 'A widget',
    shortDescription: '',
    status: 'active',
    type: 'simple',
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
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  }
}

const widgets: Category = {
  id: 'cat-1',
  slug: 'widgets',
  name: 'Widgets',
  description: 'All widgets',
  parentId: null,
  position: 0,
  createdAt: new Date().toISOString(),
}

/** The catalogue rows the projection reads: products (with variants and category ids) and categories. */
function catalogueRows(products: ProductSnapshot[], categories: Category[] = []) {
  const store = { read: <T>(fn: (tx: ReadTx) => Promise<T>) => fn({} as ReadTx) }
  const byId = new Map(products.map((p) => [p.id, p]))
  const categoryById = new Map(categories.map((c) => [c.id, c]))
  const repos = {
    product: {
      store,
      async findById(_tx: ReadTx, id: string) {
        const p = byId.get(id)
        if (!p) return null
        const { variants: _v, categoryIds: _c, ...product } = p
        return product
      },
    },
    variant: {
      store,
      findByProduct: async (_tx: ReadTx, productId: string) => byId.get(productId)?.variants ?? [],
    },
    category: {
      store,
      findById: async (_tx: ReadTx, id: string) => categoryById.get(id) ?? null,
    },
    productCategory: {
      store,
      listCategoriesForProduct: async (_tx: ReadTx, productId: string) =>
        byId.get(productId)?.categoryIds ?? [],
      listProductsForCategory: async (_tx: ReadTx, categoryId: string) =>
        products.filter((p) => p.categoryIds.includes(categoryId)).map((p) => p.id),
    },
  }
  return repos as unknown as ProductProjectionDeps['repos']
}

describe('product-projection', () => {
  it('writes denormalised product + category index on create, equal to the shared builder over the same rows', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    const product = makeProduct()
    await registerProductProjection({
      eventBus,
      documentStore,
      logger,
      storeId: 'test-store',
      currency: 'GBP',
      repos: catalogueRows([product]),
    })

    await eventBus.publish(makeEvent(EVT_PRODUCT_CREATED, { product }))
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get<DenormalisedProduct>('products', 'widget')
    expect(doc).not.toBeNull()
    expect(doc!.slug).toBe('widget')
    expect(doc!.inStock).toBe(true)
    expect(doc!.variantCount).toBe(1)
    // One definition of a document: the live projection writes what a rebuild builds from the same rows.
    expect(doc).toEqual(
      buildProductDoc(product, new Map(), { storeId: 'test-store', currency: 'GBP', logger }),
    )

    // Without a resolved category, no by-category entry is written
    const index = await documentStore.get('products-by-category', 'category:cat-1#product:widget')
    expect(index).toBeNull()
  })

  it('includes resolved category name and slug in read model', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    const product = makeProduct(['cat-1'])

    // The category is a row in the command store when the product event is handled
    await registerProductProjection({
      eventBus,
      documentStore,
      logger,
      storeId: 'test-store',
      currency: 'GBP',
      repos: catalogueRows([product], [widgets]),
    })

    await eventBus.publish(makeEvent(EVT_PRODUCT_CREATED, { product }))
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get<DenormalisedProduct>('products', 'widget')
    expect(doc).not.toBeNull()
    expect(doc!.categories).toHaveLength(1)
    expect(doc!.categories[0]).toMatchObject({ id: 'cat-1', name: 'Widgets', slug: 'widgets' })

    // by-category index uses slug as partition key (matches URL ?category=widgets)
    const index = await documentStore.get('products-by-category', 'category:widgets#product:widget')
    expect(index).not.toBeNull()
  })

  it('categories is empty array when no matching category rows exist', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    const product = makeProduct(['unknown-cat'])
    await registerProductProjection({
      eventBus,
      documentStore,
      logger,
      storeId: 'test-store',
      currency: 'GBP',
      repos: catalogueRows([product], [widgets]),
    })

    await eventBus.publish(makeEvent(EVT_PRODUCT_CREATED, { product }))
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
    await registerProductProjection({
      eventBus,
      documentStore,
      logger,
      storeId: 'test',
      currency: 'GBP',
      repos: catalogueRows([]),
    })
    await eventBus.publish(makeEvent(EVT_PRODUCT_DELETED, { productId: 'p', slug: 'gone' }))
    await new Promise((r) => setImmediate(r))
    expect(await documentStore.get('products', 'gone')).toBeNull()
    expect(
      await documentStore.get('products-by-category', 'category:x-things#product:gone'),
    ).toBeNull()
  })
})
