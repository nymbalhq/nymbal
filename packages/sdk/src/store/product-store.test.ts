import { describe, it, expect, vi } from 'vitest'
import { createProductStore } from './product-store.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { DenormalisedProduct } from '../types.js'

function makeProduct(overrides?: Partial<DenormalisedProduct>): DenormalisedProduct {
  return {
    id: 'p1', slug: 'test-product', name: 'Test', description: '',
    shortDescription: '', status: 'active', type: 'simple',
    media: [], variantCount: 1, inStock: true, priceRange: null,
    currency: 'GBP', priceMinor: 1000,
    variants: [{ id: 'v1', sku: 'S1', name: 'D', priceMinor: 1000, stock: 5, options: [] }],
    categoryIds: [], categories: [],
    createdAt: '', updatedAt: '',
    ...overrides,
  }
}

function makeAdapter(product?: DenormalisedProduct): CommerceAdapter {
  return {
    products: {
      getBySlug: vi.fn().mockResolvedValue(product ?? makeProduct()),
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      search: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    },
  } as unknown as CommerceAdapter
}

describe('ProductStore', () => {
  it('initial state has no product', () => {
    const store = createProductStore(makeAdapter())
    expect(store.getState().product).toBeNull()
    expect(store.getState().selectedVariant).toBeNull()
    expect(store.getState().loading).toBe(false)
  })

  it('loadBySlug fetches product and selects first variant', async () => {
    const store = createProductStore(makeAdapter())
    await store.loadBySlug('test-product')
    const state = store.getState()
    expect(state.product?.slug).toBe('test-product')
    expect(state.selectedVariant?.id).toBe('v1')
    expect(state.loading).toBe(false)
  })

  it('loadBySlug sets error state on failure', async () => {
    const adapter = makeAdapter()
    vi.mocked(adapter.products.getBySlug).mockRejectedValueOnce(new Error('not found'))
    const store = createProductStore(adapter)
    await store.loadBySlug('bad-slug')
    expect(store.getState().error).toBe('not found')
    expect(store.getState().loading).toBe(false)
  })

  it('selectVariant changes selectedVariant', async () => {
    const store = createProductStore(makeAdapter())
    await store.loadBySlug('test-product')
    const newVariant = { id: 'v2', productId: 'p1', sku: 'S2', name: 'Large', priceMinor: 1500, compareAtPriceMinor: null, weightGrams: null, dimensions: null, stock: 3, lowStockThreshold: 1, options: [], status: 'active' as const, createdAt: '', updatedAt: '' }
    store.selectVariant(newVariant)
    expect(store.getState().selectedVariant?.id).toBe('v2')
  })

  it('loadBySlug with no variants selects null', async () => {
    const adapter = makeAdapter(makeProduct({ variants: [] }))
    const store = createProductStore(adapter)
    await store.loadBySlug('no-variants')
    expect(store.getState().selectedVariant).toBeNull()
  })
})
