import {
  NotFoundError,
  type DocumentStoreAdapter,
  type HttpAdapter,
} from '@nymbal/types'
import { ok, renderError, fail } from './envelope.js'

export function registerProductRoutes(
  adapter: HttpAdapter,
  documentStore: DocumentStoreAdapter,
  storeName: string,
): void {
  adapter.registerRoute('GET', '/api/products', async (ctx) => {
    try {
      const rawLimit = ctx.query.limit
      const limit = Math.min(
        100,
        Math.max(1, Number(Array.isArray(rawLimit) ? rawLimit[0] : rawLimit) || 20),
      )
      const rawCursor = ctx.query.cursor
      const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor
      const rawCategory = ctx.query.category
      const category = Array.isArray(rawCategory) ? rawCategory[0] : rawCategory

      if (category) {
        const result = await documentStore.query('products-by-category', {
          partitionKey: { field: 'partitionKey', value: `category:${category}` },
          limit,
          ...(cursor !== undefined && { cursor }),
        })
        return ok(result.items, { nextCursor: result.nextCursor })
      }

      const result = await documentStore.query('products', {
        partitionKey: { field: 'storeId', value: storeName },
        limit,
        ...(cursor !== undefined && { cursor }),
      })
      return ok(result.items, { nextCursor: result.nextCursor })
    } catch (err) {
      return renderError(err)
    }
  })

  adapter.registerRoute('GET', '/api/products/:slug', async (ctx) => {
    try {
      const slug = ctx.params.slug
      if (!slug) return fail('products.slug_required', 'slug param required', 400)
      const doc = await documentStore.get('products', slug)
      if (!doc) throw new NotFoundError('product', slug)
      return ok(doc)
    } catch (err) {
      return renderError(err)
    }
  })
}
