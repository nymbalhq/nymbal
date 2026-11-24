import type { APIRequestContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { signInAsAdmin } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { signInByForm } from '../../support/dialog-clicks'
import { expect, test } from '../../support/fixtures'
import { phoneWidths } from '../../support/phone-width'

// A variant's weight on its product's page in the built admin on a real store: what the merchant types and saves is
// the weightGrams the admin API then answers and the field shows after a reload; emptied and saved, the API answers
// null. At a phone's width the variant table, a column wider, scrolls inside its card. Every product is the journey's.

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

interface StoredVariant {
  id: string
  weightGrams: number | null
}

interface Stored {
  id: string
  slug: string
  variants: StoredVariant[]
}

/** A product of the journey's own with two variants and no weights; `sku` names the first variant's SKU. */
async function twoVariants(
  request: APIRequestContext,
  token: string,
  sku?: string,
): Promise<Stored> {
  const tag = randomUUID().slice(0, 8)
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), ...auth(token) },
    data: {
      slug: `e2e-weighed-${tag}`,
      name: `E2E Weighed ${tag}`,
      status: 'active',
      type: 'variable',
      variants: [
        { sku: sku ?? `WG-S-${tag}`, name: 'Small', priceMinor: 1500, stock: 3, options: [] },
        { sku: `WG-L-${tag}`, name: 'Large', priceMinor: 1900, stock: 3, options: [] },
      ],
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  return ((await res.json()) as { data: Stored }).data
}

async function adminProduct(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<Stored> {
  const res = await request.get(`${API_URL}/api/admin/products/${id}`, { headers: auth(token) })
  expect(res.status(), `GET /api/admin/products/${id}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: Stored }).data
}

/** Each variant's weight as the admin API answers it, in the order the product was created with. */
async function weights(request: APIRequestContext, token: string, product: Stored) {
  const stored = await adminProduct(request, token, product.id)
  return product.variants.map((v) => stored.variants.find((s) => s.id === v.id)?.weightGrams)
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

test.describe('A variant’s weight on its product’s page', () => {
  // Kills: no field; a Save that reports success while the store holds no weight; a weight saved on the other variant;
  // an emptied field that leaves the weight; a double-clicked Save that writes twice.
  test('AC-7: 750 typed for the first of two variants and saved (Save double-clicked) is the weightGrams GET /api/admin/products/:id answers, the other null, with one applied update; after a reload the field shows 750; emptied and saved, the API answers null', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await twoVariants(request, token)
    const [first] = product.variants as [StoredVariant, StoredVariant]
    const field = () => page.getByTestId(`admin-product-variant-weight-${first.id}`)
    expect(await weights(request, token, product), 'the weights before the save').toEqual([
      null,
      null,
    ])
    await signInAsAdmin(page)

    await page.goto(`products/${product.slug}`)
    await page.getByTestId('admin-product-tab-variants').click()
    await expect(field()).toHaveValue('', { timeout: 15_000 })
    await field().fill('750')
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    await page.getByTestId('admin-product-save').dblclick()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 15_000 })

    expect(await weights(request, token, product), 'the weights after the save').toEqual([
      750,
      null,
    ])
    expect(await appliedUpdates(request, token, product.id), 'applied product.update entries').toBe(
      1,
    )

    await page.reload()
    await page.getByTestId('admin-product-tab-variants').click()
    await expect(field()).toHaveValue('750', { timeout: 15_000 })

    await field().fill('')
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    await page.getByTestId('admin-product-save').click()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 15_000 })
    expect(await weights(request, token, product), 'the weights after emptying').toEqual([
      null,
      null,
    ])
  })
})

test.describe('A variant’s weight at a phone’s width @phone-width', () => {
  // Kills: a sixth column (and a 64-character SKU) that widens the product page on a phone, or a card that hides the
  // overflow, so the page fits while the Weight column is cut off out of reach.
  test('AC-7: at 412 px the Variants tab of a product whose SKU is 64 characters is no wider than the viewport, the table’s wrapper scrolls it (overflow-x auto or scroll) within the viewport, and once scrolled the weight input’s right edge is inside the viewport', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const sku = `W${randomUUID().replace(/-/g, '').toUpperCase()}`.padEnd(64, 'X')
    const product = await twoVariants(request, token, sku)
    const [first] = product.variants as [StoredVariant, StoredVariant]
    const rowId = `admin-product-variant-row-${first.id}`

    await signInByForm(page)
    await page.goto(`products/${product.slug}`)
    await page.getByTestId('admin-product-tab-variants').click()
    await expect(page.getByTestId(rowId)).toContainText(sku, { timeout: 15_000 })

    const { viewport, ...widths } = await phoneWidths(page, 'product variants tab')
    expect.soft(widths.scrollWidth, widths.measured).toBeLessThanOrEqual(viewport + 1)
    expect.soft(widths.innerWidth, widths.measured).toBe(viewport)

    // The first element between the table and the page that does not let its overflow show: it must scroll, not clip.
    const wrapper = await page.getByTestId(rowId).evaluate((row) => {
      const table = row.closest('table')
      for (
        let el = table?.parentElement ?? null;
        el !== null && el !== document.body;
        el = el.parentElement
      ) {
        const overflow = getComputedStyle(el).overflowX
        if (overflow !== 'visible') return { overflow, width: el.getBoundingClientRect().width }
      }
      return { overflow: 'visible', width: Number.POSITIVE_INFINITY }
    })
    expect(['auto', 'scroll'], `the table's wrapper overflow-x: ${wrapper.overflow}`).toContain(
      wrapper.overflow,
    )
    expect(wrapper.width, 'the wrapper’s width').toBeLessThanOrEqual(viewport + 1)

    const weight = page.getByTestId(`admin-product-variant-weight-${first.id}`)
    await weight.scrollIntoViewIfNeeded()
    const box = await weight.boundingBox()
    const left = box === null ? Number.NEGATIVE_INFINITY : box.x
    const right = box === null ? Number.POSITIVE_INFINITY : box.x + box.width
    expect(
      { left: left >= -1, right: right <= viewport + 1 },
      `the weight input: ${left} to ${right}, viewport ${viewport}`,
    ).toEqual({ left: true, right: true })
    const after = await phoneWidths(page, 'product variants tab scrolled')
    expect(after.scrollWidth, after.measured).toBeLessThanOrEqual(viewport + 1)
  })
})
