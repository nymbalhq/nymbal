import { request as playwrightRequest } from '@playwright/test'
import { expect } from './fixtures'
import { API_URL, csrf } from './csrf'

/**
 * P1-06 AC-10 preflight: the API the suite runs against refuses a bare cart write with 403 `csrf.invalid`, and takes
 * the same write with the pair from `GET /api/csrf`. Without the first half every journey passing would prove nothing
 * about CSRF; without the second the refusal could be any 403.
 */
export async function assertCsrfEnforced(): Promise<void> {
  const context = await playwrightRequest.newContext()
  try {
    const products = await context.get(`${API_URL}/api/products?limit=20`)
    expect(products.ok(), 'GET /api/products should succeed').toBe(true)
    const body = (await products.json()) as {
      data: { items: Array<{ variants?: Array<{ id: string }> }> }
    }
    const variantId = body.data.items.flatMap((p) => p.variants ?? [])[0]?.id
    expect(variantId, 'the seed provides a variant').toBeTruthy()

    const bare = await context.post(`${API_URL}/api/cart/items`, { data: { variantId, qty: 1 } })
    expect(bare.status()).toBe(403)
    expect(((await bare.json()) as { error?: { code: string } }).error?.code).toBe('csrf.invalid')

    const paired = await context.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(context),
      data: { variantId, qty: 1 },
    })
    expect(paired.status()).toBeLessThan(300)
    expect(paired.status()).not.toBe(bare.status())
  } finally {
    await context.dispose()
  }
}
