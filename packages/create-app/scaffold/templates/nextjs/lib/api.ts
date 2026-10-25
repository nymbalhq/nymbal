import { cache } from 'react'
import { unstable_rethrow } from 'next/navigation'
import type {
  DenormalisedProduct,
  ProductListResult,
  ProductSearchResult,
  ReviewsListResult,
} from '@nymbalhq/sdk'
import { DEFAULT_PRODUCT_SORT, ORDER_KEY_HEADER, PRODUCT_SORT_KEYS } from '@nymbalhq/types'
import type {
  Cart,
  Category,
  ProductSortKey,
  ShopperOrder,
  StoreCapabilities,
} from '@nymbalhq/types'

const API_URL = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'

/**
 * Seconds a catalog read stays in Next's data cache: each is at least the TTL of the longest route that reads it, since
 * a route's TTL is the smallest of its segment's and its fetches'. NYMBAL_CATALOG_REVALIDATE_S replaces every one.
 */
const CATALOG_REVALIDATE_S = {
  capabilities: 3600,
  categories: 21600,
  product: 300,
  products: 300,
  reviews: 60,
} as const

function revalidateOf(read: keyof typeof CATALOG_REVALIDATE_S, seconds?: number): number {
  const override = Number(process.env.NYMBAL_CATALOG_REVALIDATE_S)
  if (Number.isInteger(override) && override > 0) return override
  return seconds ?? CATALOG_REVALIDATE_S[read]
}

/**
 * A catalog read through Next's data cache. It resolves a 200 or a 404 (an answer about the data, which the caller
 * reads); a network error, a 5xx or any other refusal (a rate limit's 429) rejects, so a failed first render is an
 * error Next does not cache and a failed regeneration keeps the last good page, where an empty value would be cached
 * for every shopper. `next dev` caches no page but still keeps fetches, so there the read is fresh and a catalog edit
 * shows at once.
 */
async function catalogFetch(
  url: string,
  read: keyof typeof CATALOG_REVALIDATE_S,
  seconds?: number,
): Promise<Response> {
  const res = await fetch(
    url,
    process.env.NODE_ENV === 'development'
      ? { cache: 'no-store' }
      : { next: { revalidate: revalidateOf(read, seconds) } },
  )
  if (!res.ok && res.status !== 404) throw new Error(`[api] GET ${url} answered ${res.status}`)
  return res
}

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

  const res = await catalogFetch(url.toString(), 'products')
  if (!res.ok) return { items: [], nextCursor: null }
  const envelope = (await res.json()) as { data: ProductListResult }
  return envelope.data ?? { items: [], nextCursor: null }
}

/** What the store can do, which decides what the page renders; null when the API has no capabilities to report. */
export async function fetchCapabilities(): Promise<StoreCapabilities | null> {
  const res = await catalogFetch(`${API_URL}/api/capabilities`, 'capabilities')
  if (!res.ok) return null
  const envelope = (await res.json()) as { data: StoreCapabilities }
  return envelope.data ?? null
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

/**
 * The product, or null when the API has none by that slug (a 404, the only answer that is null). `revalidateS` is the
 * caller's route TTL when it is shorter than the default: callers share one data-cache entry, and Next judges its
 * staleness by each caller's own seconds, so the PDP's 60 s regeneration reads stock no older than 60 s.
 */
export async function fetchProduct(
  slug: string,
  revalidateS?: number,
): Promise<DenormalisedProduct | null> {
  const url = `${API_URL}/api/products/${encodeURIComponent(slug)}`
  const res = await catalogFetch(url, 'product', revalidateS)
  if (res.status === 404) return null
  const envelope = (await res.json()) as { data: DenormalisedProduct }
  return envelope.data ?? null
}

/** The store's categories as the API lists them; never a list of its own, which a cached page would then show. */
export async function fetchCategories(): Promise<Category[]> {
  const url = `${API_URL}/api/categories`
  const res = await catalogFetch(url, 'categories')
  if (!res.ok) throw new Error(`[api] GET ${url} answered ${res.status}`)
  const envelope = (await res.json()) as { data: Category[] }
  return envelope.data
}

/**
 * The order its key opens, `key` being the confirmation URL's `?key=`. Null on a 404, which the API answers alike for
 * an unknown number and for an order read without its key; rejects when the API fails, so the order page's failed read
 * is a 500 and never a not-found page for an order the shopper has. The key goes in a header, never in the API's URL.
 */
export async function loadOrder(orderNumber: string, key?: string): Promise<ShopperOrder | null> {
  const url = `${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`
  const res = await fetch(url, {
    cache: 'no-store',
    headers: key ? { [ORDER_KEY_HEADER]: key } : {},
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`[api] GET ${url} answered ${res.status}`)
  const envelope = (await res.json()) as { data?: ShopperOrder | null }
  if (!envelope.data) throw new Error(`[api] GET ${url} answered no data`)
  return envelope.data
}

export async function fetchReviews(productId: string): Promise<ReviewsListResult> {
  const res = await catalogFetch(
    `${API_URL}/api/products/${encodeURIComponent(productId)}/reviews`,
    'reviews',
  )
  if (!res.ok) return { items: [], nextCursor: null }
  const envelope = (await res.json()) as { data: ReviewsListResult }
  return envelope.data ?? { items: [], nextCursor: null }
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
