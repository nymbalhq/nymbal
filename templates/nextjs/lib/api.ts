import type { DenormalisedProduct, ProductListResult, ReviewsListResult } from '@nymbal/sdk'
import type { Category, Order } from '@nymbal/types'

const API_URL = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'

export async function fetchProducts(params?: {
  limit?: number
  cursor?: string
  category?: string
}): Promise<ProductListResult> {
  const url = new URL('/api/products', API_URL)
  if (params?.limit) url.searchParams.set('limit', String(params.limit))
  if (params?.cursor) url.searchParams.set('cursor', params.cursor)
  if (params?.category) url.searchParams.set('category', params.category)

  try {
    const res = await fetch(url.toString(), { cache: 'no-store' })
    if (!res.ok) return { items: [], nextCursor: null }
    return (await res.json()) as ProductListResult
  } catch {
    return { items: [], nextCursor: null }
  }
}

export async function fetchProduct(slug: string): Promise<DenormalisedProduct | null> {
  try {
    const res = await fetch(`${API_URL}/api/products/${encodeURIComponent(slug)}`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as DenormalisedProduct
  } catch {
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
    return (await res.json()) as Category[]
  } catch {
    return SEED_CATEGORIES
  }
}

export async function fetchOrder(orderNumber: string): Promise<Order | null> {
  try {
    const res = await fetch(`${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as Order
  } catch {
    return null
  }
}

export async function fetchReviews(productId: string): Promise<ReviewsListResult> {
  try {
    const res = await fetch(`${API_URL}/api/products/${encodeURIComponent(productId)}/reviews`, { cache: 'no-store' })
    if (!res.ok) return { items: [], nextCursor: null }
    return (await res.json()) as ReviewsListResult
  } catch {
    return { items: [], nextCursor: null }
  }
}
