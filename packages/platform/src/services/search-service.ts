import type {
  Facet,
  FacetParams,
  SearchAdapter,
  SearchParams,
  SearchResult,
  Logger,
} from '@nymbalhq/types'

export interface SearchService {
  products(query: string, params?: SearchParams): Promise<SearchResult>
  facet(field: string, params?: FacetParams): Promise<Facet>
}

export function createSearchService(deps: {
  adapter: SearchAdapter
  logger: Logger
}): SearchService {
  return {
    async products(query, params) {
      return deps.adapter.search(query, params)
    },
    async facet(field, params) {
      return deps.adapter.facet(field, params)
    },
  }
}
