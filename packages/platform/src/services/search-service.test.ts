import { describe, expect, it, vi } from 'vitest'
import type { SearchAdapter, SearchParams, SearchResult } from '@nymbalhq/types'
import { createSearchService } from './search-service.js'
import { createLogger } from '../logger.js'

function makeAdapter(): SearchAdapter {
  return {
    providerName: 'test',
    kind: 'search',
    capabilities: () => [],
    producesEvents: [],
    consumesEvents: [],
    initialize: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ status: 'healthy' }),
    index: vi.fn().mockResolvedValue({ indexed: 0 }),
    remove: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue({ items: [{ id: 'p1', type: 'product', fields: { name: 'Widget' } }], total: 1, nextCursor: null }),
    facet: vi.fn().mockResolvedValue({ field: 'type', buckets: [] }),
  }
}

describe('SearchService', () => {
  it('products delegates query to SearchAdapter.search', async () => {
    const adapter = makeAdapter()
    const service = createSearchService({ adapter, logger: createLogger({ pretty: false, level: 'error' }) })
    const result = await service.products('widget')
    expect(adapter.search).toHaveBeenCalledWith('widget', undefined)
    expect(result.items).toHaveLength(1)
  })

  // Defect: the service drops the page size or cursor on the way to the adapter, or answers another page than its own.
  it('products passes params through to adapter and answers its page', async () => {
    const adapter = makeAdapter()
    // A page that depends on every argument, so one lost on the way gives a different page.
    const pageFor = (query: string, params?: SearchParams): SearchResult => ({
      items: Array.from({ length: params?.limit ?? 20 }, (_, i) => ({
        id: `${query}-${params?.cursor ?? 'start'}-${i}`,
        type: 'product',
        fields: {},
      })),
      total: 100,
      nextCursor: `${params?.cursor ?? 'start'}+${params?.limit ?? 20}`,
    })
    vi.mocked(adapter.search).mockImplementation(async (query, params) => pageFor(query, params))
    const service = createSearchService({ adapter, logger: createLogger({ pretty: false, level: 'error' }) })
    const params = { limit: 5, cursor: 'abc' }
    expect(await service.products('shoes', params)).toEqual(pageFor('shoes', params))
  })
})
