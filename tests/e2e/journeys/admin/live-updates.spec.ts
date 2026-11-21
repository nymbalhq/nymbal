import { randomUUID } from 'node:crypto'
import {
  request as playwrightRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { placeOrder, realtimeConnected, signInAsAdmin, watchRealtime } from '../../support/admin'
import { adminToken, ownProduct } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// What the open admin shows of changes made by another client (an admin token of its own, through the API), with no
// page load: an order moved to processing, a product created and renamed, and a stock adjustment.

interface Placed {
  orderId: string
  orderNumber: string
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function apiGet<T>(request: APIRequestContext, token: string, path: string): Promise<T> {
  const res = await request.get(`${API_URL}${path}`, { headers: auth(token) })
  expect(res.ok(), `GET ${path}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: T }).data
}

/** A paid order of its own product, from a guest cart of its own, once the admin API reads it confirmed. */
async function paidOrder(request: APIRequestContext, token: string): Promise<Placed> {
  const guest = await playwrightRequest.newContext()
  try {
    const placed = await placeOrder(
      guest,
      `e2e-live-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`,
    )
    await expect
      .poll(
        async () =>
          (
            await apiGet<{ status: string }>(
              request,
              token,
              `/api/admin/orders/${placed.orderNumber}`,
            )
          ).status,
        { timeout: 10_000, message: 'the stub confirms a paid order' },
      )
      .toBe('confirmed')
    return placed
  } finally {
    await guest.dispose()
  }
}

async function processElsewhere(request: APIRequestContext, token: string, orderId: string) {
  const res = await request.post(`${API_URL}/api/admin/orders/${orderId}/process`, {
    headers: { ...(await csrf(request)), ...auth(token) },
  })
  expect(res.ok(), `POST /api/admin/orders/${orderId}/process: ${await res.text()}`).toBe(true)
}

/** Counts the page's loads from now on. */
function countLoads(page: Page): () => number {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  return () => loads
}

/** The cell of `row` under the column headed `header`. */
async function cellUnder(page: Page, row: Locator, header: string): Promise<Locator> {
  const headers = (await page.getByRole('columnheader').allTextContents()).map((h) => h.trim())
  const column = headers.indexOf(header)
  expect(column, `the ${header} column in ${JSON.stringify(headers)}`).toBeGreaterThanOrEqual(0)
  return row.getByRole('cell').nth(column)
}

const totalStock = (product: { variants: Array<{ stock: number }> }) =>
  product.variants.reduce((sum, v) => sum + v.stock, 0)

test.describe('The admin follows changes made elsewhere', () => {
  test('AC-11: an order moved to processing by another client reads Processing in the open orders list, and on an open detail page its badge reads Processing with one more timeline entry, within 15 s and with no page load', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const token = await adminToken(request)
    const listed = await paidOrder(request, token)
    const detailed = await paidOrder(request, token)
    await watchRealtime(page)
    await signInAsAdmin(page)

    await page.goto('orders')
    const row = page.getByTestId(`admin-orders-row-${listed.orderNumber}`)
    await expect(row).toContainText('Confirmed', { timeout: 15_000 })
    await realtimeConnected(page)
    const listLoads = countLoads(page)
    await processElsewhere(request, token, listed.orderId)
    await expect(row).toContainText('Processing', { timeout: 15_000 })
    await expect(row).not.toContainText('Confirmed')
    expect(listLoads(), 'page loads on the orders list').toBe(0)

    await page.goto(`orders/${detailed.orderNumber}`)
    const badge = page.getByTestId('admin-order-status-badge')
    await expect(badge).toHaveText('Confirmed', { timeout: 15_000 })
    await realtimeConnected(page)
    await page.getByTestId('admin-order-tab-timeline').click()
    const entries = page.locator('[data-testid^="admin-order-timeline-entry-"]')
    await expect(entries.first()).toBeVisible()
    const entriesBefore = await entries.count()
    const detailLoads = countLoads(page)
    await processElsewhere(request, token, detailed.orderId)
    await expect(badge).toHaveText('Processing', { timeout: 15_000 })
    await expect(entries).toHaveCount(entriesBefore + 1, { timeout: 15_000 })
    await expect(page.getByTestId('admin-order-timeline-entry-processing')).toHaveCount(1)
    expect(detailLoads(), 'page loads on the detail page').toBe(0)

    for (const order of [listed, detailed]) {
      const read = await apiGet<{ status: string }>(
        request,
        token,
        `/api/admin/orders/${order.orderNumber}`,
      )
      expect(read.status, `GET /api/admin/orders/${order.orderNumber}`).toBe('processing')
    }
  })

  test('AC-12: a product created by another client appears in the open, searched products list, and its rename shows in that row, within 15 s and with no page load, as GET /api/admin/products/:id says', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const tag = randomUUID().slice(0, 8)
    const name = `Live Product ${tag}`
    await watchRealtime(page)
    await signInAsAdmin(page)

    await page.goto('products')
    const searched = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/admin/products' &&
        new URL(r.url()).searchParams.get('q') === name,
    )
    await page.getByPlaceholder('Search products...').fill(name)
    await searched
    await expect(page.getByText('No products found')).toBeVisible({ timeout: 15_000 })
    await realtimeConnected(page)
    const loads = countLoads(page)

    const created = await request.post(`${API_URL}/api/admin/products`, {
      headers: { ...(await csrf(request)), ...auth(token) },
      data: {
        slug: `live-${tag}`,
        name,
        description: 'A product of one live-update journey.',
        status: 'active',
        variants: [
          { sku: `LIVE-${tag}`, name: 'Default', priceMinor: 1500, stock: 2, options: [] },
        ],
      },
    })
    expect(created.status(), `POST /api/admin/products: ${await created.text()}`).toBe(201)
    const { id } = ((await created.json()) as { data: { id: string } }).data
    const row = page.getByTestId(`admin-products-row-${id}`)
    await expect(row).toContainText(name, { timeout: 15_000 })

    const renamed = `${name} renamed`
    const patched = await request.patch(`${API_URL}/api/admin/products/${id}`, {
      headers: { ...(await csrf(request)), ...auth(token) },
      data: { name: renamed },
    })
    expect(patched.ok(), `PATCH /api/admin/products/${id}: ${await patched.text()}`).toBe(true)
    const served = await apiGet<{ name: string }>(request, token, `/api/admin/products/${id}`)
    expect(served.name).toBe(renamed)
    await expect(await cellUnder(page, row, 'Name')).toContainText(served.name, { timeout: 15_000 })
    expect(loads(), 'page loads on the products list').toBe(0)
  })

  test("AC-14: a stock adjustment by another client moves the open inventory row by its delta and, in a second browser signed in on its own, the open products row's total stock, within 15 s and with no page load, as the API says", async ({
    page,
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(150_000)
    const baseURL = testInfo.project.use.baseURL
    if (baseURL === undefined) throw new Error(`project ${testInfo.project.name} has no baseURL`)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 6)
    const { id: productId } = await apiGet<{ id: string }>(
      request,
      token,
      `/api/admin/products/${product.slug}`,
    )
    const delta = 4

    await watchRealtime(page)
    await signInAsAdmin(page)
    await page.goto('inventory')
    await page.getByPlaceholder('Search SKU or product...').fill(product.name)
    const inventoryRow = page.getByTestId(`admin-inventory-row-${product.variantId}`)
    await expect(inventoryRow).toBeVisible({ timeout: 15_000 })
    await realtimeConnected(page)
    const inventoryStock = await cellUnder(page, inventoryRow, 'Stock')
    const stockBefore = Number(await inventoryStock.textContent())

    // One refresh chain per browser context: a second tab on this context would refresh the same cookie.
    const other = await browser.newContext({ baseURL })
    try {
      const productsPage = await other.newPage()
      await watchRealtime(productsPage)
      await signInAsAdmin(productsPage)
      await productsPage.goto('products')
      await productsPage.getByPlaceholder('Search products...').fill(product.name)
      const productsRow = productsPage.getByTestId(`admin-products-row-${productId}`)
      await expect(productsRow).toBeVisible({ timeout: 15_000 })
      await realtimeConnected(productsPage)
      const productsStock = await cellUnder(productsPage, productsRow, 'Stock')
      const totalBefore = Number(await productsStock.textContent())
      const inventoryLoads = countLoads(page)
      const productsLoads = countLoads(productsPage)

      const adjusted = await request.post(
        `${API_URL}/api/admin/inventory/${product.variantId}/adjust`,
        {
          headers: { ...(await csrf(request)), ...auth(token) },
          data: { delta, reason: 'manual' },
        },
      )
      expect(adjusted.ok(), `POST …/adjust: ${await adjusted.text()}`).toBe(true)

      await expect(inventoryStock).toHaveText(String(stockBefore + delta), { timeout: 15_000 })
      await expect(productsStock).toHaveText(String(totalBefore + delta), { timeout: 15_000 })

      const rows = await apiGet<Array<{ variantId: string; stock: number }>>(
        request,
        token,
        `/api/admin/inventory?q=${encodeURIComponent(product.name)}`,
      )
      const served = await apiGet<{ variants: Array<{ stock: number }> }>(
        request,
        token,
        `/api/admin/products/${productId}`,
      )
      expect(
        [Number(await inventoryStock.textContent()), Number(await productsStock.textContent())],
        'the inventory row and the products row, against the API',
      ).toEqual([rows.find((r) => r.variantId === product.variantId)!.stock, totalStock(served)])
      expect([inventoryLoads(), productsLoads()], 'page loads on either page').toEqual([0, 0])
    } finally {
      await other.close()
    }
  })
})
