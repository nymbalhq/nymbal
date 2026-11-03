import type { Category, DocumentStoreAdapter, HttpAdapter } from '@nymbalhq/types'
import { ok, renderError } from './envelope.js'

export function registerCategoryRoutes(
  adapter: HttpAdapter,
  documentStore: DocumentStoreAdapter,
  storeName: string,
): void {
  adapter.registerRoute('GET', '/api/categories', async () => {
    try {
      const all: Array<Category & { storeId: string; position: number }> = []
      let cursor: string | undefined
      do {
        const page = await documentStore.query<Category & { storeId: string; position: number }>(
          'categories',
          {
            partitionKey: { field: 'storeId', value: storeName },
            limit: 500,
            ...(cursor !== undefined && { cursor }),
          },
        )
        all.push(...page.items)
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      return ok(all.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)))
    } catch (err) {
      return renderError(err)
    }
  })
}
