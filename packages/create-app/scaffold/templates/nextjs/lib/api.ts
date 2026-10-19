import type { DenormalisedProduct, ProductListResult, ReviewsListResult } from '@nymbalhq/sdk'
import { DEFAULT_PRODUCT_SORT, PRODUCT_SORT_KEYS } from '@nymbalhq/types'
import type { Category, Order, ProductSortKey } from '@nymbalhq/types'

const API_URL = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'

export async function fetchProducts(params?: {
  limit?: number
  cursor?: string
  category?: string
  sort?: ProductSortKey
}): Promise<ProductListResult> {
  const url = new URL('/api/products', API_URL)
  if (params?.limit) url.searchParams.set('limit', String(params.limit))
  if (params?.cursor) url.searchParams.set('cursor', params.cursor)
  if (params?.category) url.searchParams.set('category', params.category)
  if (params?.sort) url.searchParams.set('sort', params.sort)

  try {
    const res = await fetch(url.toString(), { cache: 'no-store' })
    if (!res.ok) return { items: [], nextCursor: null }
    const envelope = (await res.json()) as { data: ProductListResult }
    return envelope.data ?? { items: [], nextCursor: null }
  } catch (err) {
    console.error('[api] fetchProducts failed', err)
    return { items: [], nextCursor: null }
  }
}

/** The sort a listing URL asks for; a missing or unknown `?sort=` is the default. */
export function sortFromSearchParams(params: { sort?: string | string[] }): ProductSortKey {
  const sort = Array.isArray(params.sort) ? params.sort[0] : params.sort
  return PRODUCT_SORT_KEYS.find((key) => key === sort) ?? DEFAULT_PRODUCT_SORT
}

export async function fetchProduct(slug: string): Promise<DenormalisedProduct | null> {
  try {
    const res = await fetch(`${API_URL}/api/products/${encodeURIComponent(slug)}`, { cache: 'no-store' })
    if (!res.ok) return null
    const envelope = (await res.json()) as { data: DenormalisedProduct }
    return envelope.data ?? null
  } catch (err) {
    console.error('[api] fetchProduct failed', err)
    return null
  }
}

const SEED_CATEGORIES: Category[] = [
  { id: 'cat_apparel', parentId: null, name: 'Apparel', slug: 'apparel', description: 'Clothing and accessories', position: 0, createdAt: '2024-01-01T00:00:00Z' },
  { id: 'cat_home', parentId: null, name: 'Home', slug: 'home', description: 'Home goods and decor', position: 1, createdAt: '2024-01-01T00:00:00Z' },
  { id: 'cat_electronics', parentId: null, name: 'Electronics', slug: 'electronics', description: 'Gadgets and devices', position: 2, createdAt: '2024-01-01T00:00:00Z' },
  { id: 'cat_books', parentId: null, name: 'Books', slug: 'books', description: 'Books and reading', position: 3, createdAt: '2024-01-01T00:00:00Z' },
]

export async function fetchCategories(): Promise<Category[]> {
  try {
    const res = await fetch(`${API_URL}/api/categories`, { cache: 'no-store' })
    if (!res.ok) return SEED_CATEGORIES
    const envelope = (await res.json()) as { data: Category[] }
    return envelope.data ?? SEED_CATEGORIES
  } catch (err) {
    console.error('[api] fetchCategories failed', err)
    return SEED_CATEGORIES
  }
}

export async function fetchOrder(orderNumber: string): Promise<Order | null> {
  try {
    const res = await fetch(`${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`, { cache: 'no-store' })
    if (!res.ok) return null
    const envelope = (await res.json()) as { data: Order }
    return envelope.data ?? null
  } catch (err) {
    console.error('[api] fetchOrder failed', err)
    return null
  }
}

export async function fetchReviews(productId: string): Promise<ReviewsListResult> {
  try {
    const res = await fetch(`${API_URL}/api/products/${encodeURIComponent(productId)}/reviews`, { cache: 'no-store' })
    if (!res.ok) return { items: [], nextCursor: null }
    const envelope = (await res.json()) as { data: ReviewsListResult }
    return envelope.data ?? { items: [], nextCursor: null }
  } catch (err) {
    console.error('[api] fetchReviews failed', err)
    return { items: [], nextCursor: null }
  }
}
