import { describe, it, expect, vi } from 'vitest'
import { createProductListStore } from './product-list-store.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'

const emptyItem = { id: 'p1', slug: 'p1', name: 'P', description: '', shortDescription: '', status: 'active' as const, type: 'simple' as const, seoTitle: '', seoDescription: '', media: [], metadata: {}, priceMinor: 1000, compareAtPriceMinor: null, currency: 'GBP', variants: [], categories: [], reviewCount: 0, averageRating: 0, createdAt: '', updatedAt: '' }

function makeAdapter(nextCursor: string | null = null, items = [emptyItem]): CommerceAdapter {
  return {
    products: {
      list: vi.fn().mockResolvedValue({ items, nextCursor }),
      getBySlug: vi.fn(),
      search: vi.fn(),
    },
  } as unknown as CommerceAdapter
}

describe('ProductListStore', () => {
  it('initial state is empty', () => {
    const store = createProductListStore(makeAdapter())
    expect(store.getState().products).toHaveLength(0)
    expect(store.getState().loading).toBe(false)
  })

  it('load fetches products and sets state', async () => {
    const store = createProductListStore(makeAdapter())
    await store.load()
    expect(store.getState().products).toHaveLength(1)
    expect(store.getState().loading).toBe(false)
    expect(store.getState().pagination.hasMore).toBe(false)
  })

  it('load sets hasMore when nextCursor is non-null', async () => {
    const store = createProductListStore(makeAdapter('cursor-abc'))
    await store.load()
    expect(store.getState().pagination.hasMore).toBe(true)
    expect(store.getState().pagination.cursor).toBe('cursor-abc')
  })

  it('loadMore appends items when hasMore is true', async () => {
    const adapter = makeAdapter('cursor-1')
    const store = createProductListStore(adapter)
    await store.load()
    vi.mocked(adapter.products.list).mockResolvedValueOnce({ items: [{ ...emptyItem, id: 'p2', slug: 'p2' }], nextCursor: null })
    await store.loadMore()
    expect(store.getState().products).toHaveLength(2)
    expect(store.getState().pagination.hasMore).toBe(false)
  })

  it('loadMore does nothing when hasMore is false', async () => {
    const adapter = makeAdapter(null)
    const store = createProductListStore(adapter)
    await store.load()
    await store.loadMore()
    expect(adapter.products.list).toHaveBeenCalledTimes(1)
  })

  it('applyFilter triggers a new load with filter', async () => {
    const adapter = makeAdapter()
    const store = createProductListStore(adapter)
    await store.applyFilter('category', 'apparel')
    expect(adapter.products.list).toHaveBeenCalledTimes(1)
    expect(store.getState().filters['category']).toBe('apparel')
  })

  it('removeFilter triggers reload without that filter', async () => {
    const adapter = makeAdapter()
    const store = createProductListStore(adapter)
    await store.applyFilter('category', 'shoes')
    await store.removeFilter('category')
    expect(store.getState().filters['category']).toBeUndefined()
  })

  it('setSort updates sort and reloads', async () => {
    const adapter = makeAdapter()
    const store = createProductListStore(adapter)
    await store.setSort('price', 'asc')
    expect(store.getState().sort).toEqual({ field: 'price', direction: 'asc' })
    expect(adapter.products.list).toHaveBeenCalled()
  })

  it('load on error sets loading false', async () => {
    const adapter = makeAdapter()
    vi.mocked(adapter.products.list).mockRejectedValueOnce(new Error('fail'))
    const store = createProductListStore(adapter)
    await store.load()
    expect(store.getState().loading).toBe(false)
  })
})
