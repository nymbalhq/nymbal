import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { ProductSearchParams, SearchState } from '../types.js'
import { createStore } from './create-store.js'

const INITIAL_STATE: SearchState = {
  query: '',
  category: null,
  results: [],
  total: 0,
  nextCursor: null,
  facets: [],
  loading: false,
}

export interface SearchOptions {
  category?: string | null
  origin?: ProductSearchParams['origin']
}

export interface SearchStore {
  getState(): SearchState
  subscribe(listener: () => void): () => void
  /**
   * Page 1 of `query`, in `options.category` (a slug) when given, otherwise in every category. `options.origin` marks
   * the search page's own request, the one a miss is counted from; every other caller leaves it out.
   */
  search(query: string, options?: SearchOptions): Promise<void>
  /** Appends the next page; a no-op when every match is loaded or a page is loading. */
  loadMore(): Promise<void>
  /** Page 1 of the current query in `category` (a slug), or in every category when null. */
  setCategory(category: string | null): Promise<void>
  clearSearch(): void
  destroy(): void
}

export function createSearchStore(adapter: CommerceAdapter): SearchStore {
  const store = createStore<SearchState>(INITIAL_STATE)
  // Each search supersedes the last: an answer for an older one is dropped.
  let generation = 0

  async function search(query: string, options?: SearchOptions): Promise<void> {
    const category = options?.category ?? null
    const current = store.getState()
    // React's Strict Mode runs a mount effect twice; the repeat of a marked search still loading would count a miss twice.
    if (options?.origin !== undefined && current.loading && current.query === query && current.category === category) {
      return
    }
    const run = ++generation
    if (!query.trim()) {
      store.setState({ ...INITIAL_STATE })
      return
    }
    store.setState({ query, category, loading: true })
    try {
      const params: ProductSearchParams = {
        ...(category !== null && { category }),
        ...(options?.origin !== undefined && { origin: options.origin }),
      }
      const result = await (Object.keys(params).length === 0
        ? adapter.products.search(query)
        : adapter.products.search(query, params))
      if (run !== generation) return
      store.setState({
        results: result.items,
        total: result.total,
        nextCursor: result.nextCursor,
        facets: result.facets ?? [],
        loading: false,
      })
    } catch (err) {
      if (run !== generation) return
      console.error('[SearchStore] search failed', err)
      store.setState({ loading: false })
    }
  }

  async function loadMore(): Promise<void> {
    const { query, category, nextCursor, loading } = store.getState()
    if (nextCursor === null || loading) return
    const run = generation
    store.setState({ loading: true })
    try {
      const result = await adapter.products.search(query, {
        cursor: nextCursor,
        ...(category !== null && { category }),
      })
      if (run !== generation) return
      store.setState({
        results: [...store.getState().results, ...result.items],
        total: result.total,
        nextCursor: result.nextCursor,
        loading: false,
      })
    } catch (err) {
      if (run !== generation) return
      console.error('[SearchStore] load more failed', err)
      store.setState({ loading: false })
    }
  }

  function setCategory(category: string | null): Promise<void> {
    return search(store.getState().query, { category })
  }

  function clearSearch(): void {
    generation++
    store.setState({ ...INITIAL_STATE })
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    search,
    loadMore,
    setCategory,
    clearSearch,
    destroy: store.destroy,
  }
}
