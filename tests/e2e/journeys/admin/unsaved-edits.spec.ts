import type { APIRequestContext, Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { signInAsAdmin } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// The product page's unsaved edit in the built admin on a real store (the real router under /admin): `g o` and a
// sidebar link ask "Leave without saving?" while "Unsaved changes" shows; Stay keeps the typed name, Leave goes and
// saves nothing; after a finished Save, `g o` goes with no question and the store has the saved name.

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

/** A draft product of this journey's own, created through the admin API. */
async function journeyProduct(
  request: APIRequestContext,
  token: string,
): Promise<{ id: string; slug: string; name: string }> {
  const tag = randomUUID().slice(0, 8)
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), ...auth(token) },
    data: {
      slug: `unsaved-${tag}`,
      name: `Unsaved Journey ${tag}`,
      description: 'A product of one unsaved-edits journey.',
      status: 'draft',
      variants: [{ sku: `UNS-${tag}`, name: 'Default', priceMinor: 1800, stock: 5, options: [] }],
    },
  })
  expect(res.ok(), `POST /api/admin/products: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: { id: string; slug: string; name: string } }).data
}

/** The product's name as the admin API holds it. */
async function storedName(request: APIRequestContext, token: string, id: string): Promise<string> {
  const res = await request.get(`${API_URL}/api/admin/products/${id}`, { headers: auth(token) })
  expect(res.status(), `GET /api/admin/products/${id}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: { name: string } }).data.name
}

/** `g o` with focus on Save, which is not a typing target. */
async function goOrders(page: Page) {
  await page.getByTestId('admin-product-save').focus()
  await page.keyboard.press('g')
  await page.keyboard.press('o')
}

test.describe('Unsaved edits on the product page', () => {
  // Kills: the guard missing from the built admin; Leave saving or Stay dropping the edit; the guard still asking
  // after a finished Save.
  test('AC-8: with a typed name, g o and the sidebar Orders link ask; Stay keeps the name; Leave reaches /admin/orders and saves nothing; after Save clears the mark, g o reaches /admin/orders with no dialog and the store has the saved name', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const created = await journeyProduct(request, token)
    await signInAsAdmin(page)

    await page.goto(`products/${created.slug}`)
    const name = page.getByTestId('admin-product-name')
    const dialog = page.getByTestId('admin-unsaved-dialog')
    const unsaved = page.getByText('Unsaved changes')
    await expect(name).toHaveValue(created.name, { timeout: 15_000 })
    const productUrl = page.url()

    const typed = `${created.name} typed`
    await name.fill(typed)
    await expect(unsaved).toBeVisible()
    await goOrders(page)
    await expect(dialog).toBeVisible()
    expect(page.url(), 'the URL while the dialog asks').toBe(productUrl)

    await page.getByTestId('admin-unsaved-stay').click()
    await expect(dialog).toBeHidden()
    await expect(name).toHaveValue(typed)
    expect(page.url(), 'the URL after Stay').toBe(productUrl)

    await page.getByTestId('admin-nav-orders').click()
    await expect(dialog).toBeVisible()
    await page.getByTestId('admin-unsaved-leave').click()
    await expect(page).toHaveURL(/\/admin\/orders$/)
    expect(await storedName(request, token, created.id), 'the name after Leave').toBe(created.name)

    await page.goto(`products/${created.slug}`)
    await expect(name).toHaveValue(created.name, { timeout: 15_000 })
    await expect
      .poll(() => name.inputValue(), { message: 'the reopened form shows the store copy' })
      .toBe(await storedName(request, token, created.id))
    const saved = `${created.name} saved`
    await name.fill(saved)
    await expect(unsaved).toBeVisible()
    await page.getByTestId('admin-product-save').click()
    await expect(unsaved).toBeHidden({ timeout: 15_000 })

    await goOrders(page)
    await expect(page).toHaveURL(/\/admin\/orders$/)
    await expect(dialog).toHaveCount(0)
    expect(await storedName(request, token, created.id), 'the name after Save').toBe(saved)
  })
})
