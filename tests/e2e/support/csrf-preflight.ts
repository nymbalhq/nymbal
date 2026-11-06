import { request as playwrightRequest } from '@playwright/test'
import { adminToken, ownProduct } from './checkout'
import { API_URL, csrf } from './csrf'
import { expect } from './fixtures'

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

/**
 * A product of its own, created active with stock and then unpublished, so it would be the newest in-stock product
 * on the first products page if the list still served it. Resolves once the read side has taken the unpublish: the
 * slug is gone, or (where the list still serves drafts) served as a draft.
 */
export async function unpublishedNewest(): Promise<{ slug: string; variantId: string }> {
  const context = await playwrightRequest.newContext()
  try {
    const token = await adminToken(context)
    const product = await ownProduct(context, token, 5)
    const auth = { authorization: `Bearer ${token}` }
    const read = await context.get(`${API_URL}/api/admin/products/${product.slug}`, {
      headers: auth,
    })
    expect(read.status(), `GET /api/admin/products/${product.slug}`).toBe(200)
    const { id } = ((await read.json()) as { data: { id: string } }).data
    const unpublished = await context.post(`${API_URL}/api/admin/products/${id}/unpublish`, {
      headers: { ...(await csrf(context)), ...auth },
    })
    expect(unpublished.status(), await unpublished.text()).toBe(200)
    await expect
      .poll(
        async () => {
          const res = await context.get(`${API_URL}/api/products/${product.slug}`)
          if (res.status() === 404) return 'gone'
          return ((await res.json()) as { data: { status: string } }).data.status
        },
        { timeout: 10_000 },
      )
      .not.toBe('active')
    return { slug: product.slug, variantId: product.variantId }
  } finally {
    await context.dispose()
  }
}
