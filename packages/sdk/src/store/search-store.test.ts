import { describe, it, expect, vi } from 'vitest'
import { createSearchStore } from './search-store.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'

function makeAdapter(): CommerceAdapter {
  return {
    products: {
      search: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'p1',
            slug: 'p1',
            name: 'Widget',
            description: '',
            shortDescription: '',
            status: 'active',
            type: 'simple',
            seoTitle: '',
            seoDescription: '',
            media: [],
            metadata: {},
            priceMinor: 1000,
            compareAtPriceMinor: null,
            currency: 'GBP',
            variants: [],
            categories: [],
            reviewCount: 0,
            averageRating: 0,
            createdAt: '',
            updatedAt: '',
          },
        ],
        nextCursor: null,
      }),
      getBySlug: vi.fn(),
      list: vi.fn(),
    },
  } as unknown as CommerceAdapter
}

describe('SearchStore', () => {
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

  it('a later search wins: the earlier one’s late answer never replaces its results', async () => {
    const adapter = makeAdapter()
    const answer = (await adapter.products.search('x')) as { items: Array<{ id: string }> }
    const item = (id: string) => ({ ...answer.items[0]!, id, slug: id })
    let releaseFirst: () => void = () => {}
    vi.mocked(adapter.products.search)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ items: [item('stale')], nextCursor: null } as never)
          }),
      )
      .mockResolvedValueOnce({
        items: [item('fresh-1'), item('fresh-2')],
        nextCursor: null,
      } as never)
    const store = createSearchStore(adapter)

    const first = store.search('mug')
    await store.search('mugs')
    const fresh = store.getState().results.map((r) => r.id)
    releaseFirst()
    await first

    expect(store.getState().query).toBe('mugs')
    expect(store.getState().results.map((r) => r.id)).toEqual(fresh.slice())
    expect(fresh).toEqual(['fresh-1', 'fresh-2'])
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
    expect(store.getState().results).toHaveLength(0)
    expect(store.getState().loading).toBe(false)
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
