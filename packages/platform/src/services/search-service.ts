import type { SearchAdapter, SearchParams, SearchResult, Logger } from '@nymbal/types'

export interface SearchService {
  products(query: string, params?: SearchParams): Promise<SearchResult>
}

export function createSearchService(deps: {
  adapter: SearchAdapter
  logger: Logger
}): SearchService {
  return {
    async products(query, params) {
      return deps.adapter.search(query, params)
    },
  }
}
