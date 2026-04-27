import {
  NotFoundError,
  type DocumentStoreAdapter,
  type Facet,
  type HttpAdapter,
  type ReviewsAdapter,
} from '@nymbal/types'
import type { SearchService } from '../services/search-service.js'
import { ok, renderError, fail } from './envelope.js'

function buildCategoryFacet(products: Array<Record<string, unknown>>): Facet {
  const counts = new Map<string, { name: string; count: number }>()
  for (const product of products) {
    const categories = product['categories'] as
      | Array<{ id: string; name: string; slug: string }>
      | undefined
    if (!Array.isArray(categories)) continue
    for (const cat of categories) {
      const entry = counts.get(cat.slug)
      if (entry) entry.count++
      else counts.set(cat.slug, { name: cat.name, count: 1 })
    }
  }
  return {
    field: 'category',
    label: 'Category',
    values: Array.from(counts.entries()).map(([slug, { name, count }]) => ({
      value: slug,
      label: name,
      count,
    })),
  }
}

export function registerProductRoutes(
  adapter: HttpAdapter,
  documentStore: DocumentStoreAdapter,
  storeName: string,
  reviewsAdapter?: ReviewsAdapter,
  searchService?: SearchService,
): void {
  adapter.registerRoute('GET', '/api/products/search', async (ctx) => {
    try {
      const rawQ = ctx.query.q
      const q = Array.isArray(rawQ) ? rawQ[0] : rawQ
      if (!q || !q.trim()) return ok({ items: [], nextCursor: null, facets: [] })
      if (!searchService) return ok({ items: [], nextCursor: null, facets: [] })
      const rawLimit = ctx.query.limit
      const limit = rawLimit
        ? Math.min(100, Math.max(1, Number(Array.isArray(rawLimit) ? rawLimit[0] : rawLimit) || 20))
        : 20
      const rawCursor = ctx.query.cursor
      const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor
      const searchResult = await searchService.products(q.trim(), {
        limit,
        ...(cursor !== undefined && { cursor }),
      })
      const slugs = searchResult.items
        .map((doc) => String((doc.fields as Record<string, unknown>)?.slug ?? ''))
        .filter(Boolean)
      const products = await Promise.all(slugs.map((slug) => documentStore.get('products', slug)))
      const items = products.filter(Boolean)
      return ok({ items, nextCursor: searchResult.nextCursor, facets: [] })
    } catch (err) {
      return renderError(err)
    }
  })

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

      const result = await (category
        ? documentStore.query('products-by-category', {
            partitionKey: { field: 'partitionKey', value: `category:${category}` },
            limit,
            ...(cursor !== undefined && { cursor }),
          })
        : documentStore.query('products', {
            partitionKey: { field: 'storeId', value: storeName },
            limit,
            ...(cursor !== undefined && { cursor }),
          }))

      const categoryFacet = buildCategoryFacet(result.items as Array<Record<string, unknown>>)
      return ok({ items: result.items, nextCursor: result.nextCursor, facets: [categoryFacet] })
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

  adapter.registerRoute('GET', '/api/products/:id/reviews', async (ctx) => {
    try {
      const id = ctx.params.id
      if (!id) return fail('products.id_required', 'id param required', 400)
      if (!reviewsAdapter) return ok({ items: [], nextCursor: null })
      const rawLimit = ctx.query.limit
      const limit = rawLimit
        ? Math.min(100, Math.max(1, Number(Array.isArray(rawLimit) ? rawLimit[0] : rawLimit) || 20))
        : 20
      const rawCursor = ctx.query.cursor
      const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor
      const result = await reviewsAdapter.getProductReviews(id, { limit, ...(cursor && { cursor }) })
      return ok(result)
    } catch (err) {
      return renderError(err)
    }
  })
}
