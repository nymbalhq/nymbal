import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct, type OwnProduct } from '../../support/checkout'
import { API_URL } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// The inventory page's Apply against the real store: a refused adjustment shows the store's reason and changes
// nothing, an applied one shows Done and its new stock, and the row agrees with the admin API each time.

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function stockOf(request: APIRequestContext, token: string, product: OwnProduct) {
  const res = await request.get(
    `${API_URL}/api/admin/inventory?q=${encodeURIComponent(product.name)}`,
    { headers: auth(token) },
  )
  expect(res.ok(), await res.text()).toBe(true)
  const rows = ((await res.json()) as { data: Array<{ variantId: string; stock: number }> }).data
  return rows.find((r) => r.variantId === product.variantId)!.stock
}

async function historyOf(request: APIRequestContext, token: string, product: OwnProduct) {
  const res = await request.get(`${API_URL}/api/admin/inventory/${product.variantId}/history`, {
    headers: auth(token),
  })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { data: Array<{ adjustment: number }> }).data
}

/** Flags, in `window`, the adjust row ever reading Done from now on. */
async function watchDone(page: Page, variantId: string): Promise<void> {
  await page.evaluate((testId) => {
    const w = window as unknown as { __adjustDone?: boolean }
    w.__adjustDone = false
    const el = document.querySelector(`[data-testid="${testId}"]`)!
    const check = () => {
      if (el.textContent?.includes('Done')) w.__adjustDone = true
    }
    new MutationObserver(check).observe(el, { subtree: true, childList: true, characterData: true })
  }, `admin-inventory-adjust-${variantId}`)
}

const sawDone = (page: Page) =>
  page.evaluate(() => (window as unknown as { __adjustDone?: boolean }).__adjustDone === true)

async function stockCell(page: Page, row: Locator): Promise<Locator> {
  const headers = (await page.getByRole('columnheader').allTextContents()).map((h) => h.trim())
  const column = headers.indexOf('Stock')
  expect(column, `the Stock column in ${JSON.stringify(headers)}`).toBeGreaterThanOrEqual(0)
  return row.getByRole('cell').nth(column)
}

test.describe('The stock adjust tells the truth', () => {
  test("AC-13: Apply -5 on stock 3 shows the store's refusal, never Done, and changes neither the row, the API's stock nor the history; then Apply +2 reads Done and 5, as the API says, with one more history row of 2", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 3)
    const adjustPath = `/api/admin/inventory/${product.variantId}/adjust`
    const historyBefore = await historyOf(request, token, product)

    await signInAsAdmin(page)
    await page.goto('inventory')
    await page.getByPlaceholder('Search SKU or product...').fill(product.name)
    const row = page.getByTestId(`admin-inventory-row-${product.variantId}`)
    const adjust = page.getByTestId(`admin-inventory-adjust-${product.variantId}`)
    await expect(adjust).toBeVisible({ timeout: 15_000 })
    const stock = await stockCell(page, row)
    await expect(stock).toHaveText('3')

    await watchDone(page, product.variantId)
    await adjust.getByRole('spinbutton').fill('-5')
    const [refused] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === adjustPath,
      ),
      adjust.getByRole('button', { name: 'Apply' }).click(),
    ])
    expect(refused.status(), 'the store refuses a delta below zero').toBe(400)
    const { error } = (await refused.json()) as { error: { message: string } }
    await expect(page.getByTestId(`admin-inventory-adjust-error-${product.variantId}`)).toHaveText(
      error.message,
    )
    expect(await sawDone(page), 'Done across the refusal').toBe(false)
    await expect(stock).toHaveText('3')
    expect(await stockOf(request, token, product), "the API's stock after the refusal").toBe(3)
    expect(
      (await historyOf(request, token, product)).length,
      'history rows after the refusal',
    ).toBe(historyBefore.length)

    await adjust.getByRole('spinbutton').fill('2')
    const [applied] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === adjustPath,
      ),
      adjust.getByRole('button', { name: 'Apply' }).click(),
    ])
    expect(applied.status()).toBe(200)
    await expect(adjust).toContainText('Done')
    await expect(stock).toHaveText('5')
    expect(await stockOf(request, token, product), "the API's stock after +2").toBe(5)
    const history = await historyOf(request, token, product)
    expect(history.length, 'history rows after +2').toBe(historyBefore.length + 1)
    expect(history[0]!.adjustment, 'the newest history row').toBe(2)
  })
})
