import { DEFAULT_PRODUCT_SORT, type ProductSortKey } from '@nymbalhq/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { ProductListState, ProductListParams } from '../types.js'
import { createStore } from './create-store.js'

const INITIAL_STATE: ProductListState = {
  products: [],
  facets: [],
  filters: {},
  sort: DEFAULT_PRODUCT_SORT,
  pagination: { cursor: null, hasMore: false },
  loading: false,
  error: null,
}

export interface ProductListStore {
  getState(): ProductListState
  subscribe(listener: () => void): () => void
  load(params?: ProductListParams): Promise<void>
  loadMore(): Promise<void>
  applyFilter(name: string, value: string | string[]): Promise<void>
  removeFilter(name: string): Promise<void>
  setSort(sort: ProductSortKey): Promise<void>
  destroy(): void
}

export function createProductListStore(adapter: CommerceAdapter): ProductListStore {
  const store = createStore<ProductListState>(INITIAL_STATE)
  let lastLimit: number | undefined

  function buildParams(): ProductListParams {
    const state = store.getState()
    const params: ProductListParams = { sort: state.sort }
    if (lastLimit !== undefined) params.limit = lastLimit
    const category = state.filters['category']
    if (typeof category === 'string') {
      params.category = category
    }
    return params
  }

  /** With params, they become the listing's category and sort, so `setSort` and `loadMore` keep them. */
  async function load(params?: ProductListParams): Promise<void> {
    if (params !== undefined) {
      if (params.limit !== undefined) lastLimit = params.limit
      const filters = { ...store.getState().filters }
      if (params.category !== undefined) filters['category'] = params.category
      else delete filters['category']
      store.setState({ filters, sort: params.sort ?? DEFAULT_PRODUCT_SORT })
    }
    const request = buildParams()
    if (params?.cursor !== undefined) request.cursor = params.cursor
    store.setState({ loading: true })
    try {
      const result = await adapter.products.list(request)
      store.setState({
        products: result.items,
        facets: result.facets ?? store.getState().facets,
        pagination: { cursor: result.nextCursor, hasMore: result.nextCursor !== null },
        loading: false,
        error: null,
      })
    } catch (err) {
      console.error('[ProductListStore] load failed', err)
      store.setState({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function loadMore(): Promise<void> {
    const state = store.getState()
    if (!state.pagination.hasMore || state.loading) return
    store.setState({ loading: true })
    try {
      const params = buildParams()
      if (state.pagination.cursor !== null) {
        params.cursor = state.pagination.cursor
      }
      const result = await adapter.products.list(params)
      store.setState({
        products: [...state.products, ...result.items],
        pagination: { cursor: result.nextCursor, hasMore: result.nextCursor !== null },
        loading: false,
        error: null,
      })
    } catch (err) {
      console.error('[ProductListStore] loadMore failed', err)
      store.setState({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function applyFilter(name: string, value: string | string[]): Promise<void> {
    const filters = { ...store.getState().filters, [name]: value }
    store.setState({ filters })
    await load()
  }

  async function removeFilter(name: string): Promise<void> {
    const filters = { ...store.getState().filters }
    delete filters[name]
    store.setState({ filters })
    await load()
  }

  async function setSort(sort: ProductSortKey): Promise<void> {
    store.setState({ sort })
    await load()
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    load,
    loadMore,
    applyFilter,
    removeFilter,
    setSort,
    destroy: store.destroy,
  }
}
