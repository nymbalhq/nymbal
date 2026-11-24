import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { placeOrder, signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct, shopperWithOrder } from '../../support/checkout'
import { API_URL } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// The admin's Cmd/Ctrl-K palette by keyboard alone on a real store: the pages it goes to, the records it finds by
// what a merchant remembers of them, and the commands it runs on the order whose page is open, read back through the
// admin API. A `+stub-pending` email leaves an order unpaid; any other is paid inline by the stub.

interface OrderRead {
  status: string
  history: Array<{ toStatus: string }>
}

interface SearchRead {
  orders: Array<{ orderNumber: string }>
  products: Array<{ slug: string }>
  customers: Array<{ id: string }>
}

async function adminGet<T>(request: APIRequestContext, token: string, path: string): Promise<T> {
  const res = await request.get(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET ${path}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: T }).data
}

const readOrder = (request: APIRequestContext, token: string, orderNumber: string) =>
  adminGet<OrderRead>(request, token, `/api/admin/orders/${orderNumber}`)

const search = (request: APIRequestContext, token: string, q: string) =>
  adminGet<SearchRead>(request, token, `/api/admin/search?q=${encodeURIComponent(q)}`)

/** A paid order of its own product, from a guest cart, read confirmed by the admin API before this returns. */
async function paidOrder(request: APIRequestContext, token: string): Promise<string> {
  const guest = await playwrightRequest.newContext()
  try {
    const email = `e2e-palette-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`
    const { orderNumber } = await placeOrder(guest, email)
    await expect
      .poll(async () => (await readOrder(request, token, orderNumber)).status, {
        timeout: 10_000,
        message: 'the stub confirms a paid order',
      })
      .toBe('confirmed')
    return orderNumber
  } finally {
    await guest.dispose()
  }
}

async function pendingOrder(): Promise<string> {
  const guest = await playwrightRequest.newContext()
  try {
    return (await placeOrder(guest)).orderNumber
  } finally {
    await guest.dispose()
  }
}

/** Opens the palette, types into whatever has the keyboard, and presses Enter. */
async function paletteRun(page: Page, typed: string, before?: () => Promise<void>): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type(typed)
  if (before) await before()
  await page.keyboard.press('Enter')
}

async function openOrder(page: Page, orderNumber: string, status: string): Promise<void> {
  await page.goto(`orders/${orderNumber}`)
  await expect(page.getByTestId('admin-order-status-badge')).toHaveText(status, { timeout: 15_000 })
}

test.describe('The command palette', () => {
  // Kills: no navigation commands; a product or customer the server found by name hidden by the palette's own filter.
  test('AC-8: by keyboard alone it opens Inventory by name, a product by its name and a customer by their first name', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 3)
    const buyer = await shopperWithOrder(request, 'TestPassword123!')
    // What the server's search reaches: the palette is judged only on records it returns.
    expect((await search(request, token, product.name)).products.map((p) => p.slug)).toEqual([
      product.slug,
    ])
    const byFirstName = await search(request, token, buyer.firstName)
    expect(byFirstName.customers.map((c) => c.id)).toEqual([buyer.customerId])
    expect(byFirstName.orders, 'orders whose email holds the first name').toEqual([])

    await signInAsAdmin(page)
    await page.goto('orders')
    // A full load restores the session before the shell, and with it the Cmd-K listener, renders.
    await expect(page.getByTestId('admin-search-trigger')).toBeVisible({ timeout: 15_000 })

    await paletteRun(page, 'inventory')
    await expect(page).toHaveURL(/\/admin\/inventory$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inventory')

    await paletteRun(page, product.name, async () => {
      await expect(page.getByRole('option', { name: new RegExp(product.name) })).toHaveCount(1, {
        timeout: 10_000,
      })
    })
    await expect(page).toHaveURL(new RegExp(`/admin/products/${product.slug}$`))
    await expect(page.getByTestId('admin-product-name')).toHaveValue(product.name, {
      timeout: 15_000,
    })

    await paletteRun(page, buyer.firstName, async () => {
      await expect(page.getByRole('option', { name: new RegExp(buyer.firstName) })).toHaveCount(1, {
        timeout: 10_000,
      })
    })
    await expect(page).toHaveURL(new RegExp(`/admin/customers/${buyer.customerId}$`))
    await expect(page.getByTestId('admin-customer-detail')).toContainText(buyer.email, {
      timeout: 15_000,
    })
  })

  // Kills: no order group; a command that reaches another endpoint; Cancel run with no confirmation; Cancel offered on
  // an order the server will not cancel.
  test('AC-9: on a paid order’s page "processing" + Enter moves it to Processing with one more history entry; on a pending order "cancel" + Enter asks first, its submit cancels, and the cancelled order is offered no Cancel order', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const paid = await paidOrder(request, token)
    const pending = await pendingOrder()
    const before = await readOrder(request, token, paid)

    await signInAsAdmin(page)
    await openOrder(page, paid, 'Confirmed')
    await paletteRun(page, 'processing')
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Processing', {
      timeout: 15_000,
    })
    const after = await readOrder(request, token, paid)
    expect(after.status).toBe('processing')
    expect(after.history.length, 'history entries').toBe(before.history.length + 1)

    await openOrder(page, pending, 'Pending')
    await paletteRun(page, 'cancel')
    const dialog = page.getByTestId('admin-orders-bulk-dialog')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    expect((await readOrder(request, token, pending)).status, 'before the confirmation').toBe(
      'pending',
    )
    await dialog.getByTestId('admin-orders-bulk-submit').click()
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Cancelled', {
      timeout: 15_000,
    })
    expect((await readOrder(request, token, pending)).status).toBe('cancelled')

    await dialog.getByTestId('admin-orders-bulk-dismiss').click()
    await expect(dialog).toBeHidden()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('option', { name: 'Go to Orders' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Cancel order' })).toHaveCount(0)
  })
})
