import { randomUUID } from 'node:crypto'
import { PRODUCT_SORT_KEYS } from '@nymbalhq/types'
import type { Kernel } from './kernel.js'
import { freshShop, record, type Shop } from './recently-viewed.js'

// What the product routes serve as each product's `rating`, read over HTTP from every route that serves a product:
// the listing (each sort, and within a category), search, recently viewed and the product page's own read.

/** `rating` as an item carries it; `'missing'` when the item has no such key. */
export type ServedRating = unknown

export interface ServedItem {
  /** The request that served the item. */
  route: string
  id: string
  slug: string
  rating: ServedRating
  /** The item less its `rating`, for comparing what two reads served. */
  rest: Record<string, unknown>
}

interface Envelope<T> {
  data?: T
  error?: { code: string; message: string }
}

async function getJson<T>(baseUrl: string, path: string, shop?: Shop): Promise<T> {
  if (shop !== undefined) {
    const res = await shop.call<T>('GET', path)
    if (res.status !== 200)
      throw new Error(`GET ${path}: ${res.status} ${JSON.stringify(res.body)}`)
    return res.body.data as T
  }
  const res = await fetch(new URL(path, baseUrl), { headers: { accept: 'application/json' } })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`GET ${path}: ${res.status} ${text.slice(0, 300)}`)
  return (JSON.parse(text) as Envelope<T>).data as T
}

function itemOf(route: string, raw: Record<string, unknown>): ServedItem {
  const { rating, ...rest } = raw
  return {
    route,
    id: String(raw.id),
    slug: String(raw.slug),
    rating: 'rating' in raw ? rating : 'missing',
    rest,
  }
}

/** Every page of a listing, following `nextCursor`. */
async function walk(baseUrl: string, query: Record<string, string>): Promise<ServedItem[]> {
  const items: ServedItem[] = []
  let cursor: string | null = null
  for (let n = 0; n < 100; n++) {
    const params = new URLSearchParams({
      ...query,
      limit: '100',
      ...(cursor !== null && { cursor }),
    })
    const path = `/api/products?${params.toString()}`
    const page = await getJson<{
      items: Array<Record<string, unknown>>
      nextCursor: string | null
    }>(baseUrl, path)
    const route = `GET /api/products?${new URLSearchParams(query).toString()}`
    items.push(...page.items.map((i) => itemOf(route, i)))
    cursor = page.nextCursor
    if (cursor === null) return items
  }
  throw new Error(`GET /api/products ${JSON.stringify(query)}: the walk did not end`)
}

export interface Catalogue {
  /** A term every product of the catalogue carries in its name, and no other product. */
  term: string
  categorySlug: string
  products: Array<{ id: string; slug: string }>
}

/** Products of the test's own, active, in a fresh category, each named with a fresh term. */
export async function catalogueOf(k: Kernel, size: number): Promise<Catalogue> {
  const term = `rated${randomUUID().replace(/-/g, '').slice(0, 10)}`
  const category = await k.services.category.create({
    slug: `ratings-${term}`,
    name: `Ratings ${term}`,
    description: '',
  })
  const products: Catalogue['products'] = []
  for (let i = 0; i < size; i++) {
    const slug = `${term}-${i}`
    const product = await k.services.product.create({
      slug,
      name: `Item ${term} ${String.fromCharCode(97 + i)}`,
      description: 'A product of the ratings test.',
      status: 'active',
      categoryIds: [category.id],
      variants: [
        {
          sku: `RAT-${term}-${i}`,
          name: 'Default',
          priceMinor: 1000 + 37 * i,
          stock: 5,
          options: [],
        },
      ],
    })
    products.push({ id: product.id, slug })
  }
  return { term, categorySlug: category.slug, products }
}

/** A shopper who has opened each of the catalogue's products, so its recently viewed list holds them all. */
export async function viewerOf(baseUrl: string, catalogue: Catalogue): Promise<Shop> {
  const shop = await freshShop(baseUrl)
  for (const p of catalogue.products) {
    const res = await record(shop, p.id)
    if (res.status !== 204)
      throw new Error(`the view of ${p.id}: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return shop
}

/**
 * Every item the product routes serve for the catalogue: the whole listing in each sort, the catalogue's category in
 * each sort, a search for its term, the viewer's recently viewed list and each product's own read.
 */
export async function servedItems(
  baseUrl: string,
  catalogue: Catalogue,
  viewer: Shop,
): Promise<ServedItem[]> {
  const items: ServedItem[] = []
  for (const sort of PRODUCT_SORT_KEYS) {
    items.push(...(await walk(baseUrl, { sort })))
    items.push(...(await walk(baseUrl, { sort, category: catalogue.categorySlug })))
  }
  const search = await getJson<{ items: Array<Record<string, unknown>> }>(
    baseUrl,
    `/api/products/search?${new URLSearchParams({ q: catalogue.term, limit: '100' }).toString()}`,
  )
  items.push(...search.items.map((i) => itemOf(`GET /api/products/search?q=${catalogue.term}`, i)))
  const viewed = await getJson<{ items: Array<Record<string, unknown>> }>(
    baseUrl,
    '/api/recently-viewed',
    viewer,
  )
  items.push(...viewed.items.map((i) => itemOf('GET /api/recently-viewed', i)))
  for (const p of catalogue.products) {
    const doc = await getJson<Record<string, unknown>>(baseUrl, `/api/products/${p.slug}`)
    items.push(itemOf(`GET /api/products/${p.slug}`, doc))
  }
  return items
}

/** The routes a catalogue product must be served by, so a check over served items is never vacuous. */
export function routesServing(items: ServedItem[], id: string): string[] {
  return [...new Set(items.filter((i) => i.id === id).map((i) => i.route))].sort()
}

/** The routes `servedItems` reads for a catalogue product. */
export function expectedRoutes(catalogue: Catalogue, slug: string): string[] {
  return [
    ...PRODUCT_SORT_KEYS.flatMap((sort) => [
      `GET /api/products?${new URLSearchParams({ sort }).toString()}`,
      `GET /api/products?${new URLSearchParams({ sort, category: catalogue.categorySlug }).toString()}`,
    ]),
    `GET /api/products/search?q=${catalogue.term}`,
    'GET /api/recently-viewed',
    `GET /api/products/${slug}`,
  ].sort()
}

export const round1 = (n: number): number => Math.round(n * 10) / 10
