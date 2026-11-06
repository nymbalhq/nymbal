import { randomUUID } from 'node:crypto'
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { signInAsAdmin } from '../../support/admin'
import { adminToken, shopperWithOrder } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'

// A merchant reads their customers: everyone who registered is listed, ordered or not, and a customer's page shows
// their orders and the money they kept after refunds, as the API counts it.

/** The amount as the admin formats it (`apps/admin/src/lib/money.ts`). */
function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100)
}

/** Text that ends with exactly this amount: no digit before it, so £9.99 never matches £19.99. */
function endsWithAmount(amountMinor: number, currency: string): RegExp {
  const escaped = money(amountMinor, currency).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\d.,])${escaped}\\s*$`)
}

async function registered(): Promise<{ id: string; email: string }> {
  const shopper = await playwrightRequest.newContext()
  try {
    const email = `e2e-browser-${randomUUID().slice(0, 8)}@nymbal.dev`
    const res = await shopper.post(`${API_URL}/api/auth/register`, {
      headers: await csrf(shopper),
      data: { email, password: 'TestPassword123!', firstName: 'Bea', lastName: 'Browser' },
    })
    expect(res.ok(), `POST /api/auth/register: ${await res.text()}`).toBe(true)
    return {
      id: ((await res.json()) as { data: { customer: { id: string } } }).data.customer.id,
      email,
    }
  } finally {
    await shopper.dispose()
  }
}

async function adminGet<T>(request: APIRequestContext, token: string, path: string): Promise<T> {
  const res = await request.get(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET ${path}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: T }).data
}

test.describe('Admin customers', () => {
  // Kills: the list built from orders (a customer who never ordered is missing); Order History reading `.orders` of
  // the route's array ("No orders"); Lifetime Value counting a partly refunded order at its full total.
  test('AC-14: a registered customer with no order is a row in Customers; a customer with a partly refunded paid order sees it in Order History, and Lifetime Value shows captured − refunded, as GET /api/admin/customers/:id counts it', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const browser = await registered()
    const buyer = await shopperWithOrder(request, 'TestPassword123!')
    const token = await adminToken(request)
    const order = await adminGet<{
      id: string
      orderNumber: string
      currency: string
      payment: { capturedMinor: number }
    }>(request, token, `/api/admin/orders/${buyer.orderNumber}`)
    const captured = order.payment.capturedMinor
    const part = Math.max(1, Math.floor(captured / 3))
    expect(part, 'a partial refund').toBeLessThan(captured)
    const refund = await request.post(`${API_URL}/api/admin/orders/${order.id}/refund`, {
      headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
      data: { amountMinor: part },
    })
    expect(refund.status(), await refund.text()).toBe(200)
    const { stats } = await adminGet<{ stats: { lifetimeRevenueMinor: number } }>(
      request,
      token,
      `/api/admin/customers/${buyer.customerId}`,
    )

    await signInAsAdmin(page)
    await page.goto('customers')
    await page.getByPlaceholder('Search by name or email...').fill(browser.email)
    await expect(page.getByTestId(`admin-customers-row-${browser.id}`)).toContainText(
      browser.email,
      { timeout: 15_000 },
    )

    await page.goto(`customers/${buyer.customerId}`)
    await expect(page.getByTestId('admin-customer-detail')).toContainText(buyer.email, {
      timeout: 15_000,
    })
    await expect(page.getByTestId(`admin-customer-orders-row-${order.id}`)).toContainText(
      order.orderNumber,
    )
    await expect(page.getByTestId('admin-customer-stat-lifetime-value')).toHaveText(
      endsWithAmount(stats.lifetimeRevenueMinor, order.currency),
    )
    expect(stats.lifetimeRevenueMinor, 'Lifetime Value, captured − refunded').toBe(captured - part)
  })
})
