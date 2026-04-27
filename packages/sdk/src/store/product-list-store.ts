import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { ProductListState, ProductListParams } from '../types.js'
import { createStore } from './create-store.js'

const INITIAL_STATE: ProductListState = {
  products: [],
  facets: [],
  filters: {},
  sort: null,
  pagination: { cursor: null, hasMore: false },
  loading: false,
}

export interface ProductListStore {
  getState(): ProductListState
  subscribe(listener: () => void): () => void
  load(params?: ProductListParams): Promise<void>
  loadMore(): Promise<void>
  applyFilter(name: string, value: string | string[]): Promise<void>
  removeFilter(name: string): Promise<void>
  setSort(field: string, direction: 'asc' | 'desc'): Promise<void>
  destroy(): void
}

export function createProductListStore(adapter: CommerceAdapter): ProductListStore {
  const store = createStore<ProductListState>(INITIAL_STATE)

  function buildParams(): ProductListParams {
    const state = store.getState()
    const params: ProductListParams = {}
    const category = state.filters['category']
    if (typeof category === 'string') {
      params.category = category
    }
    return params
  }

  async function load(params?: ProductListParams): Promise<void> {
    store.setState({ loading: true })
    try {
      const result = await adapter.products.list(params ?? buildParams())
      store.setState({
        products: result.items,
        pagination: { cursor: result.nextCursor, hasMore: result.nextCursor !== null },
        loading: false,
      })
    } catch {
      store.setState({ loading: false })
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
      })
    } catch {
      store.setState({ loading: false })
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

  async function setSort(field: string, direction: 'asc' | 'desc'): Promise<void> {
    store.setState({ sort: { field, direction } })
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
