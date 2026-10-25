import type {
  DenormalisedProduct,
  ProductListResult,
  ProductSearchResult,
  ReviewsListResult,
} from '@nymbalhq/sdk'
import { DEFAULT_PRODUCT_SORT, PRODUCT_SORT_KEYS } from '@nymbalhq/types'
import type {
  Cart,
  Category,
  ProductSortKey,
  ShopperOrder,
  StoreCapabilities,
} from '@nymbalhq/types'

const API_URL = import.meta.env.NYMBAL_API_URL ?? 'http://localhost:3001'

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
    const res = await fetch(url.toString())
    if (!res.ok) return { items: [], nextCursor: null }
    const envelope = (await res.json()) as { data: ProductListResult }
    return envelope.data ?? { items: [], nextCursor: null }
  } catch (err) {
    console.error('[api] fetchProducts failed', err)
    return { items: [], nextCursor: null }
  }
}

/** The API failed: it did not answer, answered an error other than a 404, or answered with no data. */
export class ApiUnavailableError extends Error {
  override name = 'ApiUnavailableError'
}

/** `GET <path>`'s data; null on a 404; rejects with ApiUnavailableError (or fetch's own error) on any other failure. */
async function apiData<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`)
  if (res.status === 404) return null
  if (!res.ok) throw new ApiUnavailableError(`GET ${path} answered ${res.status}`)
  const envelope = (await res.json()) as { data?: T | null }
  if (envelope.data === undefined || envelope.data === null) {
    throw new ApiUnavailableError(`GET ${path} answered no data`)
  }
  return envelope.data
}

/** What the store can do, as the API sent it; rejects when the API fails. */
export async function loadCapabilities(): Promise<StoreCapabilities> {
  const capabilities = await apiData<StoreCapabilities>('/api/capabilities')
  if (capabilities === null) throw new ApiUnavailableError('GET /api/capabilities answered 404')
  return capabilities
}

/** What the store can do, which decides what the page renders; null when the API did not answer. */
export async function fetchCapabilities(): Promise<StoreCapabilities | null> {
  try {
    return await loadCapabilities()
  } catch (err) {
    console.error('[api] fetchCapabilities failed', err)
    return null
  }
}

/** The sort a listing URL asks for, among the store's keys; a missing or unknown `?sort=` is the store's default. */
export function sortFromUrl(url: URL, catalog?: StoreCapabilities['catalog']): ProductSortKey {
  const sort = url.searchParams.get('sort')
  const keys = catalog?.sortKeys ?? PRODUCT_SORT_KEYS
  return keys.find((key) => key === sort) ?? catalog?.defaultSort ?? DEFAULT_PRODUCT_SORT
}

/** A product as the API sent it; null when the API has none (a 404); rejects when the API fails. */
export async function loadProduct(slug: string): Promise<DenormalisedProduct | null> {
  return apiData<DenormalisedProduct>(`/api/products/${encodeURIComponent(slug)}`)
}

/** The store's categories as the API sent them; rejects when the API fails. */
export async function loadCategories(): Promise<Category[]> {
  const categories = await apiData<Category[]>('/api/categories')
  if (categories === null) throw new ApiUnavailableError('GET /api/categories answered 404')
  return categories
}

/**
 * The store's categories, or none when the API failed: a page renders per request and no shared cache keeps it, so
 * the next request shows the store's own; a list the API did not send would link to categories the store lacks.
 */
export async function fetchCategories(): Promise<Category[]> {
  try {
    return await loadCategories()
  } catch (err) {
    console.error('[api] fetchCategories failed', err)
    return []
  }
}

export async function fetchOrder(orderNumber: string): Promise<ShopperOrder | null> {
  try {
    const res = await fetch(`${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`)
    if (!res.ok) return null
    const envelope = (await res.json()) as { data: ShopperOrder }
    return envelope.data ?? null
  } catch (err) {
    console.error('[api] fetchOrder failed', err)
    return null
  }
}

export async function fetchReviews(productId: string): Promise<ReviewsListResult> {
  try {
    const res = await fetch(`${API_URL}/api/products/${encodeURIComponent(productId)}/reviews`)
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
 * The shopper's cart, read with the request's `nymbal.cart` cookie, as the projection the elements take. Null without
 * the cookie: `GET /api/cart` with none would make a cart the page could not keep, so the element renders its shell
 * and the browser fills it. The cookie reaches this server when the store and the API share a host or a proxy.
 */
export async function fetchCart(cookie: string | null): Promise<CartProjection | null> {
  const token = cartToken(cookie)
  if (token === null) return null
  try {
    const res = await fetch(`${API_URL}/api/cart`, {
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
    console.error('[api] fetchCart failed', err)
    return null
  }
}

/** The search the search page shows for `q` (and its category), as the search store would hold it. */
export async function fetchSearch(
  q: string,
  category: string | null,
): Promise<ProductSearchResult | null> {
  const url = new URL('/api/products/search', API_URL)
  url.searchParams.set('q', q)
  if (category) url.searchParams.set('category', category)
  try {
    const res = await fetch(url.toString())
    if (!res.ok) return null
    return ((await res.json()) as { data: ProductSearchResult }).data ?? null
  } catch (err) {
    console.error('[api] fetchSearch failed', err)
    return null
  }
}
