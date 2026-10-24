import type { DenormalisedProduct } from '@nymbalhq/sdk'
import type { Category } from '@nymbalhq/types'
import { loadCapabilities, loadCategories, loadProduct } from './api'

// A fragment is cached by a CDN for hours, so it carries only what the API sent: when the API fails, the fragment
// answers an error no cache keeps, never a fallback (no categories, no search bar) a CDN would hold for its TTL.

const NOT_STORED = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }

function apiFailed(fragment: string, err: unknown): Response {
  console.error(`[fragments] ${fragment}: the API failed`, err)
  return new Response('The store API is unavailable', { status: 502, headers: NOT_STORED })
}

/** The header fragment's data: whether the store searches; a 502 `no-store` response when the API failed. */
export async function headerFragment(): Promise<{ canSearch: boolean } | Response> {
  try {
    const capabilities = await loadCapabilities()
    return { canSearch: capabilities.search.capabilities.includes('search') }
  } catch (err) {
    return apiFailed('header', err)
  }
}

/** The nav fragment's data: the API's categories; a 502 `no-store` response when the API failed. */
export async function navFragment(): Promise<{ categories: Category[] } | Response> {
  try {
    return { categories: await loadCategories() }
  } catch (err) {
    return apiFailed('nav', err)
  }
}

/**
 * The product fragment's data: the API's product; a 404 `no-store` response for a product the API does not have (a CDN
 * would apply its default 404 TTL to a 404 with no Cache-Control), a 502 `no-store` one when the API failed.
 */
export async function productFragment(
  slug: string,
): Promise<{ product: DenormalisedProduct } | Response> {
  try {
    const product = await loadProduct(slug)
    if (product === null) return new Response('Not found', { status: 404, headers: NOT_STORED })
    return { product }
  } catch (err) {
    return apiFailed('product', err)
  }
}
