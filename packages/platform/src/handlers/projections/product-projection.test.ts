import { describe, expect, it } from 'vitest'
import { EVT_PRODUCT_CREATED, EVT_PRODUCT_DELETED, type NymbalEvent } from '@nymbal/types'
import { InMemoryDocumentStore } from '../../document-store/in-memory.js'
import { InProcessEventBus } from '../../event-bus/in-process.js'
import { createLogger } from '../../logger.js'
import { registerProductProjection } from './product-projection.js'

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

describe('product-projection', () => {
  it('writes denormalised product + category index on create', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger: createLogger({ pretty: false, level: 'error' }) })
    await registerProductProjection({
      eventBus,
      documentStore,
      logger: createLogger({ pretty: false, level: 'error' }),
      storeId: 'test-store',
      currency: 'GBP',
    })

    await eventBus.publish(
      makeEvent(EVT_PRODUCT_CREATED, {
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
          categoryIds: ['cat-1'],
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
      }),
    )

    // Give synchronous dispatch a tick to finish
    await new Promise((r) => setImmediate(r))

    const doc = await documentStore.get<{ slug: string; inStock: boolean; variantCount: number }>(
      'products',
      'widget',
    )
    expect(doc).not.toBeNull()
    expect(doc!.slug).toBe('widget')
    expect(doc!.inStock).toBe(true)
    expect(doc!.variantCount).toBe(1)

    const index = await documentStore.get('products-by-category', 'category:cat-1#product:widget')
    expect(index).not.toBeNull()
  })

  it('removes documents on delete', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger: createLogger({ pretty: false, level: 'error' }) })
    await documentStore.put('products', 'gone', { categoryIds: ['cat-x'] })
    await documentStore.put('products-by-category', 'category:cat-x#product:gone', {})
    await registerProductProjection({
      eventBus,
      documentStore,
      logger: createLogger({ pretty: false, level: 'error' }),
      storeId: 'test',
      currency: 'GBP',
    })
    await eventBus.publish(
      makeEvent(EVT_PRODUCT_DELETED, { productId: 'p', slug: 'gone' }),
    )
    await new Promise((r) => setImmediate(r))
    expect(await documentStore.get('products', 'gone')).toBeNull()
    expect(await documentStore.get('products-by-category', 'category:cat-x#product:gone')).toBeNull()
  })
})
