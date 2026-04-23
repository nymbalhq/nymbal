import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { ProductState, DenormalisedVariant } from '../types.js'
import { createStore } from './create-store.js'

const INITIAL_STATE: ProductState = {
  product: null,
  selectedVariant: null,
  loading: false,
  error: null,
}

export interface ProductStore {
  getState(): ProductState
  subscribe(listener: () => void): () => void
  loadBySlug(slug: string): Promise<void>
  selectVariant(variant: DenormalisedVariant | null): void
  destroy(): void
}

export function createProductStore(adapter: CommerceAdapter): ProductStore {
  const store = createStore<ProductState>(INITIAL_STATE)

  async function loadBySlug(slug: string): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      const product = await adapter.products.getBySlug(slug)
      const firstVariant = product.variants[0] ?? null
      store.setState({
        product,
        selectedVariant: firstVariant,
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function selectVariant(variant: DenormalisedVariant | null): void {
    store.setState({ selectedVariant: variant })
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    loadBySlug,
    selectVariant,
    destroy: store.destroy,
  }
}
