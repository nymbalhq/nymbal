import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { SearchState } from '../types.js'
import { createStore } from './create-store.js'

const INITIAL_STATE: SearchState = {
  query: '',
  results: [],
  total: 0,
  loading: false,
}

export interface SearchStore {
  getState(): SearchState
  subscribe(listener: () => void): () => void
  search(query: string): Promise<void>
  clearSearch(): void
  destroy(): void
}

export function createSearchStore(adapter: CommerceAdapter): SearchStore {
  const store = createStore<SearchState>(INITIAL_STATE)

  async function search(query: string): Promise<void> {
    if (!query.trim()) {
      store.setState({ query: '', results: [], total: 0, loading: false })
      return
    }
    store.setState({ query, loading: true })
    try {
      const result = await adapter.products.search(query)
      store.setState({
        results: result.items,
        total: result.items.length,
        loading: false,
      })
    } catch (err) {
      console.error('[SearchStore] search failed', err)
      store.setState({ loading: false })
    }
  }

  function clearSearch(): void {
    store.setState({ query: '', results: [], total: 0, loading: false })
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    search,
    clearSearch,
    destroy: store.destroy,
  }
}
