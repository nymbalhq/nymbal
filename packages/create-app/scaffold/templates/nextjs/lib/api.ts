import { cache } from 'react'
import { unstable_rethrow } from 'next/navigation'
import type {
  DenormalisedProduct,
  ProductListResult,
  ProductSearchResult,
  ReviewsListResult,
} from '@nymbalhq/sdk'
import { DEFAULT_PRODUCT_SORT, PRODUCT_SORT_KEYS } from '@nymbalhq/types'
import type { Cart, Category, Order, ProductSortKey, StoreCapabilities } from '@nymbalhq/types'

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

/** What the store can do, which decides what the page renders; null when the API did not answer. */
export async function fetchCapabilities(): Promise<StoreCapabilities | null> {
  try {
    const res = await fetch(`${API_URL}/api/capabilities`, { cache: 'no-store' })
    if (!res.ok) return null
    const envelope = (await res.json()) as { data: StoreCapabilities }
    return envelope.data ?? null
  } catch (err) {
    // Next signals a request-time render by throwing from fetch at build; that must reach Next, not become null.
    unstable_rethrow(err)
    console.error('[api] fetchCapabilities failed', err)
    return null
  }
}

/** The sort a listing URL asks for, among the store's keys; a missing or unknown `?sort=` is the store's default. */
export function sortFromSearchParams(
  params: { sort?: string | string[] },
  catalog?: StoreCapabilities['catalog'],
): ProductSortKey {
  const sort = Array.isArray(params.sort) ? params.sort[0] : params.sort
  const keys = catalog?.sortKeys ?? PRODUCT_SORT_KEYS
  return keys.find((key) => key === sort) ?? catalog?.defaultSort ?? DEFAULT_PRODUCT_SORT
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

/** The cart the cart elements take as their `cart` attribute: its lines and sums, never the cart token. */
export interface CartProjection {
  items: Cart['items']
  subtotalMinor: number
  currency: string
  itemCount: number
}

const CART_COOKIE = 'nymbal.cart'

/** The `nymbal.cart` value in a request's Cookie header, or null. */
function cartToken(cookie: string | null): string | null {
  for (const pair of (cookie ?? '').split(';')) {
    const [name, ...value] = pair.trim().split('=')
    if (name === CART_COOKIE && value.length > 0) return value.join('=')
  }
  return null
}

/**
 * The shopper's cart, read with the request's `nymbal.cart` cookie, as the projection the elements take; once per
 * request, however many server components ask. Null without the cookie: `GET /api/cart` with none would make a cart
 * the page could not keep, so the element renders its shell and the browser fills it. The cookie reaches this server
 * when the store and the API share a host or a proxy.
 */
export const fetchCart = cache(async (cookie: string | null): Promise<CartProjection | null> => {
  const token = cartToken(cookie)
  if (token === null) return null
  try {
    const res = await fetch(`${API_URL}/api/cart`, {
      cache: 'no-store',
      headers: { Cookie: `${CART_COOKIE}=${token}` },
    })
    if (!res.ok) return null
    const { items, subtotalMinor, currency } = ((await res.json()) as { data: Cart }).data
    return {
      items,
      subtotalMinor,
      currency,
      itemCount: items.reduce((n, item) => n + item.qty, 0),
    }
  } catch (err) {
    unstable_rethrow(err)
    console.error('[api] fetchCart failed', err)
    return null
  }
})

/** The search the search page shows for `q` (and its category), as the search store would hold it. */
export async function fetchSearch(
  q: string,
  category: string | null,
): Promise<ProductSearchResult | null> {
  const url = new URL('/api/products/search', API_URL)
  url.searchParams.set('q', q)
  if (category) url.searchParams.set('category', category)
  try {
    const res = await fetch(url.toString(), { cache: 'no-store' })
    if (!res.ok) return null
    return ((await res.json()) as { data: ProductSearchResult }).data ?? null
  } catch (err) {
    unstable_rethrow(err)
    console.error('[api] fetchSearch failed', err)
    return null
  }
}
