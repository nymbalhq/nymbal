import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { API_URL, csrf } from './csrf'
import { expect } from './fixtures'

// P2-12 helpers for the PDP journeys on both templates: a product of the test's own whose variants are given option
// combinations, the API's view of it, and the API's view of the shopper's cart.

export interface VariantOption {
  name: string
  value: string
}

export interface OptionCombination {
  options: VariantOption[]
  priceMinor: number
  stock: number
}

export interface ServedVariant {
  id: string
  priceMinor: number
  stock: number
  options: VariantOption[]
}

export interface ServedProduct {
  slug: string
  currency: string
  variants: ServedVariant[]
}

export interface CartLine {
  variantId: string
  qty: number
}

/**
 * An active product with one variant per combination, in the given order, created through the admin API and returned
 * as GET /api/products/:slug serves it once the read side has it.
 */
export async function optionProduct(
  request: APIRequestContext,
  token: string,
  combinations: OptionCombination[],
): Promise<ServedProduct> {
  const tag = randomUUID().slice(0, 8)
  const slug = `p2-12-${tag}`
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: {
      slug,
      name: `Variant Journey ${tag}`,
      description: 'A product whose variants are option combinations.',
      status: 'active',
      type: 'variable',
      variants: combinations.map((c, i) => ({
        sku: `P212-${tag}-${i}`,
        name: c.options.map((o) => o.value).join(' / '),
        priceMinor: c.priceMinor,
        stock: c.stock,
        options: c.options,
      })),
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  await expect
    .poll(async () => (await request.get(`${API_URL}/api/products/${slug}`)).status(), {
      timeout: 10_000,
    })
    .toBe(200)
  return servedProduct(request, slug)
}

/** The product as the storefront API serves it. */
export async function servedProduct(
  request: APIRequestContext,
  slug: string,
): Promise<ServedProduct> {
  const res = await request.get(`${API_URL}/api/products/${slug}`)
  expect(res.status(), `GET /api/products/${slug}`).toBe(200)
  return ((await res.json()) as { data: ServedProduct }).data
}

/** The lines of the cart the page's browser context holds, as GET /api/cart serves them. */
export async function cartLines(page: Page): Promise<CartLine[]> {
  const res = await page.request.get(`${API_URL}/api/cart`)
  expect(res.status(), 'GET /api/cart').toBe(200)
  return ((await res.json()) as { data: { items: CartLine[] } }).data.items
}

/** The API cart's quantity of one variant, 0 when it has no line for it. */
export async function cartQty(page: Page, variantId: string): Promise<number> {
  return (await cartLines(page)).find((l) => l.variantId === variantId)?.qty ?? 0
}

/** The stock rule of the spec (P2-12 decision 5), written out here as the journeys' oracle. */
export function specStockLevel(stock: number): 'out' | 'low' | 'in' {
  return stock <= 0 ? 'out' : stock < 5 ? 'low' : 'in'
}

/** The templates' price format (`formatPrice` in each template's `lib/format.ts`). */
export function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)
}
