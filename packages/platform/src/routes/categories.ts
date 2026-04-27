import type { Category, DocumentStoreAdapter, HttpAdapter } from '@nymbal/types'
import { ok, renderError } from './envelope.js'

export function registerCategoryRoutes(
  adapter: HttpAdapter,
  documentStore: DocumentStoreAdapter,
  storeName: string,
): void {
  adapter.registerRoute('GET', '/api/categories', async () => {
    try {
      const result = await documentStore.query<Category & { storeId: string; position: number }>(
        'categories',
        { partitionKey: { field: 'storeId', value: storeName }, limit: 500 },
      )
      const sorted = result.items.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      return ok(sorted)
    } catch (err) {
      return renderError(err)
    }
  })
}
