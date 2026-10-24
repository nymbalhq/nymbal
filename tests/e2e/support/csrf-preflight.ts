import { request as playwrightRequest } from '@playwright/test'
import { expect } from './fixtures'
import { API_URL, csrf } from './csrf'

/**
 * AC-10 preflight: the API the suite runs against refuses a bare cart write with 403 `csrf.invalid`, and takes the
 * same write with the pair from `GET /api/csrf`. Without the first half every journey passing would prove nothing
 * about CSRF; without the second the refusal could be any 403.
 */
export async function assertCsrfEnforced(): Promise<void> {
  const context = await playwrightRequest.newContext()
  try {
    const products = await context.get(`${API_URL}/api/products?limit=20`)
    expect(products.ok(), 'GET /api/products should succeed').toBe(true)
    const body = (await products.json()) as {
      data: { items: Array<{ variants?: Array<{ id: string; stock: number }> }> }
    }
    // The local store persists across runs and checkout journeys drain it, so the first variant may be sold out; an
    // out-of-stock 409 would hide whether the paired write passed the CSRF check.
    const qty = 1
    const variants = body.data.items.flatMap((p) => p.variants ?? [])
    const inStock = variants.find((v) => v.stock >= qty)
    expect(
      inStock,
      `no variant on the first products page has stock >= ${qty} (${variants.length} variants seen); reseed the store`,
    ).toBeTruthy()
    const variantId = inStock?.id

    const bare = await context.post(`${API_URL}/api/cart/items`, { data: { variantId, qty } })
    expect(bare.status()).toBe(403)
    expect(((await bare.json()) as { error?: { code: string } }).error?.code).toBe('csrf.invalid')

    const paired = await context.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(context),
      data: { variantId, qty },
    })
    expect(paired.status()).toBeLessThan(300)
    expect(paired.status()).not.toBe(bare.status())
  } finally {
    await context.dispose()
  }
}
