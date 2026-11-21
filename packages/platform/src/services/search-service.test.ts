import { describe, expect, it, vi } from 'vitest'
import {
  EVT_SEARCH_ZERO_RESULTS,
  type SearchAdapter,
  type SearchParams,
  type SearchResult,
} from '@nymbalhq/types'
import type { EventPublisher } from '../events/publisher.js'
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

const publisher = { publish: vi.fn() } as unknown as EventPublisher

describe('SearchService', () => {
  it('products delegates query to SearchAdapter.search', async () => {
    const adapter = makeAdapter()
    const service = createSearchService({ adapter, publisher, logger: createLogger({ pretty: false, level: 'error' }) })
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
    const service = createSearchService({ adapter, publisher, logger: createLogger({ pretty: false, level: 'error' }) })
    const params = { limit: 5, cursor: 'abc' }
    expect(await service.products('shoes', params)).toEqual(pageFor('shoes', params))
  })

  describe('recordZeroResult', () => {
    async function recorded(query: string): Promise<Array<{ type: string; payload: unknown }>> {
      const published: Array<{ type: string; payload: unknown }> = []
      const recording = {
        publish: async (type: string, payload: unknown) => {
          published.push({ type, payload })
        },
      } as unknown as EventPublisher
      const service = createSearchService({
        adapter: makeAdapter(),
        publisher: recording,
        logger: createLogger({ pretty: false, level: 'error' }),
      })
      await service.recordZeroResult(query)
      return published
    }

    // Defect: the same miss typed with other spacing or case counts as a second term in the report.
    it('publishes one zero-result event carrying only the term, trimmed and lowercased', async () => {
      expect(await recorded('  Blue  SHOES\t')).toEqual([
        { type: EVT_SEARCH_ZERO_RESULTS, payload: { term: 'blue  shoes' } },
      ])
    })

    // Defect: padding counts towards the cut, or a pasted paragraph is kept whole in the report.
    it('cuts the term at 100 characters after trimming, and leaves one of exactly 100 whole', async () => {
      const hundred = 'a'.repeat(100)
      expect(await recorded(`   ${hundred}`)).toEqual([
        { type: EVT_SEARCH_ZERO_RESULTS, payload: { term: hundred } },
      ])
      expect(await recorded(`${hundred}b`)).toEqual([
        { type: EVT_SEARCH_ZERO_RESULTS, payload: { term: hundred } },
      ])
    })
  })
})
