import {
  DEFAULT_PRODUCT_SORT,
  NotFoundError,
  type DocumentStoreAdapter,
  type ProductSortKey,
  type QueryParams,
  type Facet,
  type HttpAdapter,
  type PublicReview,
  type PublicReviewsResult,
  type RequestContext,
  type Review,
  type ReviewsAdapter,
  type SearchAdapter,
} from '@nymbalhq/types'
import type { SearchService } from '../services/search-service.js'
import { ok, renderError, fail } from './envelope.js'
import { withRatings } from './product-ratings.js'
import { BOT } from './recently-viewed.js'

const ORDER_BY: Record<ProductSortKey, NonNullable<QueryParams['orderBy']>> = {
  newest: { field: 'createdAt', direction: 'desc' },
  'price-asc': { field: 'priceRange.minMinor', direction: 'asc', nulls: 'last' },
  'price-desc': { field: 'priceRange.minMinor', direction: 'desc', nulls: 'last' },
  'name-asc': { field: 'name', direction: 'asc' },
  'name-desc': { field: 'name', direction: 'desc' },
}

/** A review as the public list shows it: whether a purchase verified it, never who wrote it or which order. */
function publicReview(review: Review): PublicReview {
  return {
    id: review.id,
    productId: review.productId,
    rating: review.rating,
    title: review.title,
    body: review.body,
    verified: review.orderId !== null,
    submittedAt: review.submittedAt,
  }
}

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

/** A category's facet fields, by id; an id with no category is absent. */
export type CategoriesById = (
  ids: readonly string[],
) => Promise<ReadonlyMap<string, { id: string; slug: string; name: string }>>

/** The search's category counts in the listing's facet shape: field `category`, slug values, name labels. */
async function searchCategoryFacet(
  facet: SearchAdapter['facet'],
  categoriesById: CategoriesById,
  query: string,
  filters: Record<string, unknown> | undefined,
): Promise<Facet> {
  const counts = await facet('categoryIds', { query, ...(filters !== undefined && { filters }) })
  // One lookup by id, whatever the store's size: the index may hold the id of a category since deleted.
  const byId = await categoriesById(counts.values.map((v) => v.value))
  return {
    field: 'category',
    label: 'Category',
    values: counts.values.flatMap((v) => {
      const category = byId.get(v.value)
      return category === undefined
        ? []
        : [
            {
              value: category.slug,
              label: category.name,
              ...(v.count !== undefined && { count: v.count }),
            },
          ]
    }),
  }
}

/** A miss the report counts: the search page's own request for the whole catalogue, from a shopper, finding nothing. */
function isCountedMiss(
  ctx: RequestContext,
  total: number,
  cursor: string | undefined,
  category: string | undefined,
): boolean {
  if (ctx.query['origin'] !== 'page' || total !== 0 || cursor || category) return false
  const agent = ctx.headers['user-agent']
  return !(typeof agent === 'string' && BOT.test(agent))
}

export function registerProductRoutes(
  adapter: HttpAdapter,
  documentStore: DocumentStoreAdapter,
  storeName: string,
  reviewsAdapter?: ReviewsAdapter,
  searchService?: SearchService,
  /** Whether the search adapter can facet; a listing offers no filter it cannot serve. */
  canFacet: () => boolean = () => true,
  /** The search adapter's facet, for the search route's category counts within the query. */
  searchFacet?: SearchAdapter['facet'],
  /** The categories the search facet's ids name. */
  categoriesById?: CategoriesById,
): void {
  adapter.registerRoute('GET', '/api/products/search', async (ctx) => {
    try {
      const nothing = { items: [], nextCursor: null, total: 0, facets: [] }
      const rawQ = ctx.query.q
      const q = (Array.isArray(rawQ) ? rawQ[0] : rawQ)?.trim()
      if (!q || !searchService) return ok(nothing)
      const rawLimit = ctx.query.limit
      const limit = rawLimit
        ? Math.min(100, Math.max(1, Number(Array.isArray(rawLimit) ? rawLimit[0] : rawLimit) || 20))
        : 20
      const rawCursor = ctx.query.cursor
      const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor
      const rawCategory = ctx.query.category
      const categorySlug = Array.isArray(rawCategory) ? rawCategory[0] : rawCategory
      let filters: Record<string, unknown> | undefined
      if (categorySlug) {
        const category = await documentStore.get<{ id: string }>('categories', categorySlug)
        if (!category) return ok(nothing)
        filters = { categoryIds: category.id }
      }
      const searchResult = await searchService.products(q, {
        limit,
        ...(cursor !== undefined && { cursor }),
        ...(filters !== undefined && { filters }),
      })
      if (isCountedMiss(ctx, searchResult.total, cursor, categorySlug)) {
        try {
          await searchService.recordZeroResult(q)
        } catch (err) {
          ctx.logger.error({ err }, 'could not record a zero-result search')
        }
      }
      const slugs = searchResult.items
        .map((doc) => String((doc.fields as Record<string, unknown>)?.slug ?? ''))
        .filter(Boolean)
      const products = await Promise.all(slugs.map((slug) => documentStore.get('products', slug)))
      // A hit whose product is gone is dropped from the page; the total is the index's.
      const items = await withRatings(reviewsAdapter, products.filter(Boolean), ctx.logger)
      const facets =
        canFacet() &&
        searchFacet !== undefined &&
        categoriesById !== undefined &&
        searchResult.total > 0
          ? [await searchCategoryFacet(searchFacet, categoriesById, q, filters)]
          : []
      return ok({ items, nextCursor: searchResult.nextCursor, total: searchResult.total, facets })
    } catch (err) {
      return renderError(err, ctx.logger)
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
      // The schema admits only a known key.
      const sort = (ctx.query.sort as ProductSortKey | undefined) ?? DEFAULT_PRODUCT_SORT
      const orderBy = ORDER_BY[sort]

      const result = await (category
        ? documentStore.query('products-by-category', {
            partitionKey: { field: 'partitionKey', value: `category:${category}` },
            orderBy,
            limit,
            ...(cursor !== undefined && { cursor }),
          })
        : documentStore.query('products', {
            partitionKey: { field: 'storeId', value: storeName },
            orderBy,
            limit,
            ...(cursor !== undefined && { cursor }),
          }))

      const items = await withRatings(reviewsAdapter, result.items, ctx.logger)
      if (!canFacet()) return ok({ items, nextCursor: result.nextCursor })
      // Facets come from the full catalogue, never the page: a page holds only some of each category (the newest
      // products lead the default order), so its counts would understate what a filter returns.
      const allResult = await documentStore.query('products', {
        partitionKey: { field: 'storeId', value: storeName },
        limit: 1000,
      })
      const categoryFacet = buildCategoryFacet(allResult.items as Array<Record<string, unknown>>)
      return ok({ items, nextCursor: result.nextCursor, facets: [categoryFacet] })
    } catch (err) {
      return renderError(err, ctx.logger)
    }
  })

  adapter.registerRoute('GET', '/api/products/:slug', async (ctx) => {
    try {
      const slug = ctx.params.slug
      if (!slug) return fail('products.slug_required', 'slug param required', 400)
      const doc = await documentStore.get('products', slug)
      if (!doc) throw new NotFoundError('product', slug)
      const [rated] = await withRatings(reviewsAdapter, [doc], ctx.logger)
      return ok(rated)
    } catch (err) {
      return renderError(err, ctx.logger)
    }
  })

  adapter.registerRoute('GET', '/api/products/:id/reviews', async (ctx) => {
    try {
      const id = ctx.params.id
      if (!id) return fail('products.id_required', 'id param required', 400)
      if (!reviewsAdapter) return ok<PublicReviewsResult>({ items: [], nextCursor: null })
      const rawLimit = ctx.query.limit
      const limit = rawLimit
        ? Math.min(100, Math.max(1, Number(Array.isArray(rawLimit) ? rawLimit[0] : rawLimit) || 20))
        : 20
      const rawCursor = ctx.query.cursor
      const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor
      const result = await reviewsAdapter.getProductReviews(id, {
        limit,
        ...(cursor && { cursor }),
      })
      return ok<PublicReviewsResult>({
        items: result.items.map(publicReview),
        nextCursor: result.nextCursor,
      })
    } catch (err) {
      return renderError(err, ctx.logger)
    }
  })
}
