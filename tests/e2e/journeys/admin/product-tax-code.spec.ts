import type { APIRequestContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { signInByForm } from '../../support/dialog-clicks'
import { expect, test } from '../../support/fixtures'
import { phoneWidths } from '../../support/phone-width'

// A product's tax code on its page in the built admin on a real store: what the merchant types and saves is the
// taxCode the admin API then answers and the field shows after a reload; cleared and saved, the API answers null.
// Every product here is the journey's own.

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

interface Stored {
  id: string
  slug: string
  taxCode?: string | null
}

async function adminProduct(
  request: APIRequestContext,
  token: string,
  idOrSlug: string,
): Promise<Stored> {
  const res = await request.get(`${API_URL}/api/admin/products/${idOrSlug}`, {
    headers: auth(token),
  })
  expect(res.status(), `GET /api/admin/products/${idOrSlug}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: Stored }).data
}

/** The applied product.update entries the activity log holds for the product. */
async function appliedUpdates(
  request: APIRequestContext,
  token: string,
  productId: string,
): Promise<number> {
  const res = await request.get(`${API_URL}/api/admin/activity?command=product.update&limit=100`, {
    headers: auth(token),
  })
  expect(res.status(), `GET /api/admin/activity: ${await res.text()}`).toBe(200)
  const entries = (
    (await res.json()) as {
      data: Array<{ command: string; outcome: string; subjects: Array<{ id: string }> }>
    }
  ).data
  return entries.filter(
    (e) =>
      e.command === 'product.update' &&
      e.outcome === 'applied' &&
      e.subjects.some((s) => s.id === productId),
  ).length
}

test.describe('A product’s tax code on its page', () => {
  // Kills: no field; a saved code that is not what the store holds; a clear that leaves the code; a double-clicked
  // Save that writes twice.
  test('AC-6: a code typed on the product’s page and saved (Save double-clicked) is the taxCode GET /api/admin/products/:id answers, with one applied update, and the field shows it after a reload; cleared and saved, the API answers null', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const own = await ownProduct(request, token, 3)
    const before = await adminProduct(request, token, own.slug)
    const code = `reduced-${randomUUID().slice(0, 8)}`
    await signInAsAdmin(page)

    await page.goto(`products/${own.slug}`)
    const field = page.getByTestId('admin-product-tax-code')
    await expect(field).toHaveValue('', { timeout: 15_000 })
    await field.fill(code)
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    await page.getByTestId('admin-product-save').dblclick()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 15_000 })

    expect(before.taxCode ?? null, 'the journey’s product before the save').toBeNull()
    expect((await adminProduct(request, token, before.id)).taxCode).toBe(code)
    expect(await appliedUpdates(request, token, before.id), 'applied product.update entries').toBe(
      1,
    )

    await page.reload()
    await expect(page.getByTestId('admin-product-tax-code')).toHaveValue(code, { timeout: 15_000 })

    await page.getByTestId('admin-product-tax-code').fill('')
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    await page.getByTestId('admin-product-save').click()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 15_000 })
    expect((await adminProduct(request, token, before.id)).taxCode).toBeNull()
  })
})

test.describe('A product’s tax code at a phone’s width @phone-width', () => {
  // Kills: a 64-character code (the longest the routes take) that widens the product page past the phone's viewport.
  test('AC-6: a product holding a 64-character code shows it in the field, and its page is no wider than the viewport', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const tag = randomUUID().slice(0, 8)
    const code = `W${randomUUID().replace(/-/g, '')}`.padEnd(64, 'x')
    const res = await request.post(`${API_URL}/api/admin/products`, {
      headers: { ...(await csrf(request)), ...auth(token) },
      data: {
        slug: `e2e-taxed-${tag}`,
        name: `E2E Taxed ${tag}`,
        status: 'active',
        taxCode: code,
        variants: [{ sku: `TAX-${tag}`, name: 'Default', priceMinor: 1999, stock: 3, options: [] }],
      },
    })
    expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
    const created = ((await res.json()) as { data: Stored }).data
    expect(created.taxCode, 'the code the create answers').toBe(code)

    await signInByForm(page)
    await page.goto(`products/${created.slug}`)
    await expect(page.getByTestId('admin-product-tax-code')).toHaveValue(code, { timeout: 15_000 })
    const widths = await phoneWidths(page, 'product with a 64-character tax code')
    expect(widths.scrollWidth, widths.measured).toBeLessThanOrEqual(widths.viewport + 1)
    expect(widths.innerWidth, widths.measured).toBe(widths.viewport)
  })
})
