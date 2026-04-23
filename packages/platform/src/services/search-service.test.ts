import { describe, expect, it, vi } from 'vitest'
import type { SearchAdapter } from '@nymbal/types'
import { createSearchService } from './search-service.js'
import { createLogger } from '../logger.js'

function makeAdapter(): SearchAdapter {
  return {
    providerName: 'test',
    kind: 'search',
    capabilities: [],
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

  it('products passes params through to adapter', async () => {
    const adapter = makeAdapter()
    const service = createSearchService({ adapter, logger: createLogger({ pretty: false, level: 'error' }) })
    const params = { limit: 5, cursor: 'abc' }
    await service.products('shoes', params)
    expect(adapter.search).toHaveBeenCalledWith('shoes', params)
  })
})
