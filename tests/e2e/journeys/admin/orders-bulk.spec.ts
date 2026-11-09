import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { placeOrder, SHIPPING_ADDRESS, signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct, servedStock, type OwnProduct } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// The order list's Mark processing and Cancel on real orders, read back through the admin API, the Activity log and
// the storefront's stock. A `+stub-pending` email leaves an order unpaid; any other is paid inline by the stub.

const PENDING = '+stub-pending@nymbal.dev'

interface Placed {
  orderId: string
  orderNumber: string
}

interface OrderRead {
  status: string
  capturedMinor: number
  history: Array<{ toStatus: string }>
}

async function readOrder(
  request: APIRequestContext,
  token: string,
  orderNumber: string,
): Promise<OrderRead> {
  const res = await request.get(`${API_URL}/api/admin/orders/${orderNumber}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET /api/admin/orders/${orderNumber}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: OrderRead }).data
}

/** Every entry of any outcome the Activity log lists for `order.cancel` on this order. */
async function cancelEntries(
  request: APIRequestContext,
  token: string,
  orderId: string,
): Promise<Array<{ outcome: string }>> {
  const query = new URLSearchParams({ command: 'order.cancel', subject: orderId })
  const res = await request.get(`${API_URL}/api/admin/activity?${query.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET /api/admin/activity?${query.toString()}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: Array<{ outcome: string }> }).data
}

/** One order of its own product, from its own guest cart; a paid one is waited for until the admin API reads it paid. */
async function place(
  request: APIRequestContext,
  token: string,
  kind: 'pending' | 'paid',
): Promise<Placed> {
  const unique = `e2e-bulk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const email = kind === 'pending' ? `${unique}${PENDING}` : `${unique}@nymbal.dev`
  const guest = await playwrightRequest.newContext()
  try {
    const placed = await placeOrder(guest, email)
    if (kind === 'paid') {
      await expect
        .poll(async () => (await readOrder(request, token, placed.orderNumber)).status, {
          timeout: 10_000,
          message: 'the stub confirms a paid order',
        })
        .toBe('confirmed')
    }
    return placed
  } finally {
    await guest.dispose()
  }
}

/** A pending order of `qty` of a product of its own: the stock it holds is that product's alone. */
async function placeHoldingStock(
  request: APIRequestContext,
  token: string,
  qty: number,
): Promise<Placed & { product: OwnProduct; before: number }> {
  const product = await ownProduct(request, token, 6)
  const before = await servedStock(request, product)
  const shopper = await playwrightRequest.newContext()
  try {
    const added = await shopper.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(shopper),
      data: { variantId: product.variantId, qty },
    })
    expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)
    const checkout = await shopper.post(`${API_URL}/api/checkout`, {
      headers: await csrf(shopper),
      data: {
        email: `e2e-bulk-${Date.now()}-${Math.floor(Math.random() * 1e6)}${PENDING}`,
        billingAddress: SHIPPING_ADDRESS,
        shippingAddress: SHIPPING_ADDRESS,
      },
    })
    expect(checkout.ok(), `POST /api/checkout: ${await checkout.text()}`).toBe(true)
    const { orderId, orderNumber } = (
      (await checkout.json()) as { data: { orderId: string; orderNumber: string } }
    ).data
    await expect
      .poll(() => servedStock(request, product), { timeout: 10_000, message: 'stock held' })
      .toBe(before - qty)
    return { orderId, orderNumber, product, before }
  } finally {
    await shopper.dispose()
  }
}

async function openWithSelected(page: Page, orderNumbers: string[]): Promise<void> {
  await signInAsAdmin(page)
  await page.goto('orders')
  for (const orderNumber of orderNumbers) {
    const row = page.getByTestId(`admin-orders-row-${orderNumber}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.getByRole('checkbox').click()
  }
  await expect(page.getByTestId('admin-orders-bulk-count')).toContainText(
    new RegExp(`\\b${orderNumbers.length}\\b`),
  )
}

const checkbox = (page: Page, orderNumber: string) =>
  page.getByTestId(`admin-orders-row-${orderNumber}`).getByRole('checkbox')

test.describe('The order list’s bulk actions', () => {
  test('AC-14: Mark processing on two paid orders and a pending one moves the two to Processing with one more timeline entry each, as the list and the API agree, and leaves the pending one unchanged and selected', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const first = await place(request, token, 'paid')
    const second = await place(request, token, 'paid')
    const pending = await place(request, token, 'pending')
    const before = await Promise.all(
      [first, second, pending].map((o) => readOrder(request, token, o.orderNumber)),
    )

    await openWithSelected(page, [first.orderNumber, second.orderNumber, pending.orderNumber])
    await page.getByTestId('admin-orders-bulk-process').click()
    const summary = page.getByTestId('admin-orders-bulk-summary')
    await expect(summary).toHaveText(/^\D*2\D+1\D*$/)
    await expect(page.getByTestId(`admin-orders-bulk-skipped-${pending.orderNumber}`)).toContainText(
      pending.orderNumber,
    )

    await page.getByTestId('admin-orders-bulk-submit').click()
    await expect(page.getByTestId('admin-orders-bulk-result')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('admin-orders-bulk-dismiss').click()

    for (const [index, order] of [first, second].entries()) {
      await expect(page.getByTestId(`admin-orders-row-${order.orderNumber}`)).toContainText(
        'Processing',
        { timeout: 15_000 },
      )
      const read = await readOrder(request, token, order.orderNumber)
      expect(read.status).toBe('processing')
      expect(read.history.length).toBe(before[index]!.history.length + 1)
    }
    const after = await readOrder(request, token, pending.orderNumber)
    expect([after.status, after.history.length]).toEqual([
      before[2]!.status,
      before[2]!.history.length,
    ])
    await expect(checkbox(page, pending.orderNumber)).toBeChecked()
    await expect(checkbox(page, first.orderNumber)).not.toBeChecked()
  })

  test('AC-15: Cancel on two pending orders and a paid one, Submit double-clicked, cancels the two with one audit entry each and each order’s stock back at its value before checkout, and leaves the paid one unchanged', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const cancelled = [await placeHoldingStock(request, token, 2), await placeHoldingStock(request, token, 1)]
    const paid = await place(request, token, 'paid')
    const paidBefore = await readOrder(request, token, paid.orderNumber)

    await openWithSelected(page, [...cancelled.map((o) => o.orderNumber), paid.orderNumber])
    await page.getByTestId('admin-orders-bulk-cancel').click()
    const summary = page.getByTestId('admin-orders-bulk-summary')
    await expect(summary).toHaveText(/^\D*2\D+1\D*$/)
    await expect(page.getByTestId(`admin-orders-bulk-skipped-${paid.orderNumber}`)).toContainText(
      paid.orderNumber,
    )

    await page.getByTestId('admin-orders-bulk-submit').dblclick()
    await expect(page.getByTestId('admin-orders-bulk-result')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('admin-orders-bulk-dismiss').click()

    for (const order of cancelled) {
      await expect(page.getByTestId(`admin-orders-row-${order.orderNumber}`)).toContainText(
        'Cancelled',
        { timeout: 15_000 },
      )
      expect((await readOrder(request, token, order.orderNumber)).status).toBe('cancelled')
      expect(await cancelEntries(request, token, order.orderId)).toHaveLength(1)
      await expect
        .poll(() => servedStock(request, order.product), {
          timeout: 10_000,
          message: `stock of ${order.orderNumber} after the cancel`,
        })
        .toBe(order.before)
    }

    const paidAfter = await readOrder(request, token, paid.orderNumber)
    expect([paidAfter.status, paidAfter.capturedMinor, paidAfter.history.length]).toEqual([
      paidBefore.status,
      paidBefore.capturedMinor,
      paidBefore.history.length,
    ])
    expect(await cancelEntries(request, token, paid.orderId)).toEqual([])
  })

  test('AC-16: a double-clicked Submit on a two-order cancel makes one change per order: one Activity entry of any outcome each, one Cancelled timeline entry each, and a result of two changed and none failed', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const orders = [await place(request, token, 'pending'), await place(request, token, 'pending')]

    await openWithSelected(
      page,
      orders.map((o) => o.orderNumber),
    )
    await page.getByTestId('admin-orders-bulk-cancel').click()
    await page.getByTestId('admin-orders-bulk-submit').dblclick()

    const result = page.getByTestId('admin-orders-bulk-result')
    await expect(result).toHaveText(/^\D*2\D*$/, { timeout: 15_000 })
    await expect(page.locator('[data-testid^="admin-orders-bulk-failed-"]')).toHaveCount(0)

    for (const order of orders) {
      const entries = await cancelEntries(request, token, order.orderId)
      expect(entries.map((e) => e.outcome)).toEqual(['applied'])
      const { history } = await readOrder(request, token, order.orderNumber)
      expect(history.filter((h) => h.toStatus === 'cancelled').length).toBe(1)
    }
  })
})
