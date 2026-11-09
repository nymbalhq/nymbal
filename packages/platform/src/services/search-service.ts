import {
  EVT_SEARCH_ZERO_RESULTS,
  type Logger,
  type SearchAdapter,
  type SearchParams,
  type SearchResult,
} from '@nymbalhq/types'
import type { EventPublisher } from '../events/publisher.js'

/** The longest term a report keeps. */
const TERM_LENGTH = 100

export interface SearchService {
  products(query: string, params?: SearchParams): Promise<SearchResult>
  /** Records a search of the search page that found nothing: the term alone, trimmed, lowercased and cut to length. */
  recordZeroResult(query: string): Promise<void>
}

export function createSearchService(deps: {
  adapter: SearchAdapter
  publisher: EventPublisher
  logger: Logger
}): SearchService {
  return {
    async products(query, params) {
      return deps.adapter.search(query, params)
    },
    async recordZeroResult(query) {
      const term = query.trim().toLowerCase().slice(0, TERM_LENGTH)
      await deps.publisher.publish(EVT_SEARCH_ZERO_RESULTS, { term })
    },
  }
}
