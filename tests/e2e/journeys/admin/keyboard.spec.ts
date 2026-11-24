import { request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { placeOrder, signInAsAdmin } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// The admin's daily loop by keyboard alone on a real store: go-to shortcuts, the search field `/` reaches and Escape
// leaves with its text kept, a row opened with j and Enter, the shortcut help, and letters typed into a search field
// staying text.

/** A pending order from a guest cart of its own. */
async function pendingOrder(): Promise<string> {
  const guest = await playwrightRequest.newContext()
  try {
    return (await placeOrder(guest)).orderNumber
  } finally {
    await guest.dispose()
  }
}

/** The order as the admin API holds it. */
async function readOrder(
  request: APIRequestContext,
  token: string,
  orderNumber: string,
): Promise<{ email: string }> {
  const res = await request.get(`${API_URL}/api/admin/orders/${orderNumber}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET /api/admin/orders/${orderNumber}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: { email: string } }).data
}

test.describe('Keyboard shortcuts', () => {
  // Kills: any shortcut missing; one firing inside the search field; Escape clearing the search.
  test('AC-8: signed in, the keyboard alone goes to orders, finds and opens an order, goes to products and shows the help, and letters typed into a search stay text', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    // Two orders: the one searched for is not the newest, so the row j reaches is the search's, not the list's head.
    const searched = await pendingOrder()
    const newer = await pendingOrder()
    expect(newer, 'two distinct orders').not.toBe(searched)

    await signInAsAdmin(page)
    await expect(page).toHaveURL(/\/admin\/?$/)

    await page.keyboard.press('g')
    await page.keyboard.press('o')
    await expect(page).toHaveURL(/\/admin\/orders$/)

    const ordersSearch = page.getByLabel('Search orders')
    await expect(page.getByTestId(/^admin-orders-row-/).first()).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press('/')
    await expect(ordersSearch).toBeFocused()
    await page.keyboard.type(searched)
    await expect(ordersSearch).toHaveValue(searched)
    await page.keyboard.press('Escape')
    await expect(ordersSearch).not.toBeFocused()
    await expect(ordersSearch).toHaveValue(searched)

    const rows = page.getByTestId(/^admin-orders-row-/)
    await expect(rows).toHaveCount(1, { timeout: 15_000 })
    await expect(rows).toHaveAttribute('data-testid', `admin-orders-row-${searched}`)
    await page.keyboard.press('j')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/admin/orders/${searched}$`))
    await expect(page.getByTestId('admin-order-detail')).toContainText(searched, {
      timeout: 15_000,
    })
    // The order Enter opened is the searched one, as the API holds it.
    const token = await adminToken(request)
    const opened = await readOrder(request, token, searched)
    await expect(page.getByTestId('admin-order-detail')).toContainText(opened.email)

    await page.keyboard.press('g')
    await page.keyboard.press('p')
    await expect(page).toHaveURL(/\/admin\/products$/)

    const help = page.getByTestId('admin-shortcuts-help')
    await page.keyboard.press('?')
    await expect(help).toContainText('Keyboard shortcuts')
    await page.keyboard.press('Escape')
    await expect(help).toBeHidden()

    const productsSearch = page.getByLabel('Search products')
    const productsUrl = page.url()
    await page.keyboard.press('/')
    await expect(productsSearch).toBeFocused()
    await page.keyboard.type('go')
    await expect(productsSearch).toHaveValue('go')
    // Neither letter is read as a shortcut: the page is the one the field was focused on.
    expect(productsUrl, 'the URL before typing, against the URL after').toBe(page.url())
  })
})
