import { describe, it, expect, vi } from 'vitest'
import { createSearchStore } from './search-store.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'

function makeAdapter(): CommerceAdapter {
  return {
    products: {
      search: vi.fn().mockResolvedValue({
        items: [{ id: 'p1', slug: 'p1', name: 'Widget', description: '', shortDescription: '', status: 'active', type: 'simple', seoTitle: '', seoDescription: '', media: [], metadata: {}, priceMinor: 1000, compareAtPriceMinor: null, currency: 'GBP', variants: [], categories: [], reviewCount: 0, averageRating: 0, createdAt: '', updatedAt: '' }],
        nextCursor: null,
      }),
      getBySlug: vi.fn(),
      list: vi.fn(),
    },
  } as unknown as CommerceAdapter
}

describe('SearchStore', () => {
  it('initial state has empty results', () => {
    const store = createSearchStore(makeAdapter())
    expect(store.getState().results).toHaveLength(0)
    expect(store.getState().query).toBe('')
  })

  it('search updates results and clears loading', async () => {
    const adapter = makeAdapter()
    const store = createSearchStore(adapter)
    await store.search('widget')
    const state = store.getState()
    expect(adapter.products.search).toHaveBeenCalledWith('widget')
    expect(state.results).toHaveLength(1)
    expect(state.query).toBe('widget')
    expect(state.loading).toBe(false)
  })

  it('search with empty string clears results without calling adapter', async () => {
    const adapter = makeAdapter()
    const store = createSearchStore(adapter)
    await store.search('')
    expect(adapter.products.search).not.toHaveBeenCalled()
    expect(store.getState().results).toHaveLength(0)
  })

  it('search with whitespace-only string clears results', async () => {
    const adapter = makeAdapter()
    const store = createSearchStore(adapter)
    await store.search('   ')
    expect(adapter.products.search).not.toHaveBeenCalled()
  })

  it('search on adapter error sets loading false', async () => {
    const adapter = makeAdapter()
    vi.mocked(adapter.products.search).mockRejectedValueOnce(new Error('fail'))
    const store = createSearchStore(adapter)
    await store.search('widget')
    expect(store.getState().loading).toBe(false)
  })

  it('clearSearch resets all fields', async () => {
    const adapter = makeAdapter()
    const store = createSearchStore(adapter)
    await store.search('widget')
    store.clearSearch()
    const state = store.getState()
    expect(state.query).toBe('')
    expect(state.results).toHaveLength(0)
    expect(state.total).toBe(0)
  })
})
