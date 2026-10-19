import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { csrf } from '../../support/csrf'
import { placeOrder, signInAsAdmin } from '../../support/admin'
import { adminToken } from '../../support/checkout'

const API_URL = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'
const ADMIN_EMAIL = process.env.NYMBAL_ADMIN_EMAIL ?? 'admin@nymbal.local'
const ADMIN_PASSWORD = process.env.NYMBAL_ADMIN_PASSWORD ?? 'nymbal-admin-dev'

// Canonical Address shape from @nymbalhq/types (firstName/lastName/addressLine1/region).
const address = {
  firstName: 'Avery',
  lastName: 'Quinn',
  addressLine1: '42 Harbour Lane',
  city: 'Bristol',
  region: 'Bristol',
  postalCode: 'BS1 4DJ',
  country: 'GB',
}

/**
 * Creates a real pending order through the platform API: seeded product →
 * cart → checkout (native-stub payments). Every response is wrapped in the
 * { data, meta, error } envelope and must be unwrapped.
 */
async function createPendingOrder(
  request: APIRequestContext,
): Promise<{ orderId: string; orderNumber: string }> {
  const productsRes = await request.get(`${API_URL}/api/products?limit=20`)
  expect(productsRes.ok(), 'GET /api/products should succeed').toBe(true)
  const productsBody = (await productsRes.json()) as {
    data: { items: Array<{ name: string; variants?: Array<{ id: string }> }> }
  }
  const products = productsBody.data.items
  expect(products.length, 'seed should provide at least one product').toBeGreaterThan(0)

  // Walk the catalog until a variant with available stock is added.
  let added = false
  for (const product of products) {
    const variantId = product.variants?.[0]?.id
    if (!variantId) continue
    const addRes = await request.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(request, API_URL),
      data: { variantId, qty: 1 },
    })
    if (addRes.ok()) {
      added = true
      break
    }
  }
  expect(added, 'a seeded variant should be added to the cart').toBe(true)

  const checkoutRes = await request.post(`${API_URL}/api/checkout`, {
    headers: await csrf(request, API_URL),
    data: {
      // `+stub-pending` (P1-12 decision 7): the stub leaves the order pending for the admin to confirm.
      email: 'e2e-admin-orders+stub-pending@nymbal.dev',
      billingAddress: address,
      shippingAddress: address,
    },
  })
  expect(checkoutRes.ok(), 'POST /api/checkout should succeed').toBe(true)
  const checkoutBody = (await checkoutRes.json()) as {
    data: { orderId: string; orderNumber: string }
  }
  expect(checkoutBody.data.orderNumber).toMatch(/^(NYM|INT)-/)
  return {
    orderId: checkoutBody.data.orderId,
    orderNumber: checkoutBody.data.orderNumber,
  }
}

// The admin access token is held in memory only, so every full page load
// starts from the login screen.
async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('login')
  await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
  await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
  await page.getByTestId('admin-login-submit').click()
  await expect(page.getByTestId('admin-nav-orders')).toBeVisible({ timeout: 15000 })
}

async function openOrderDetail(page: Page, orderNumber: string): Promise<void> {
  await page.getByTestId('admin-nav-orders').click()
  const row = page.getByTestId(`admin-orders-row-${orderNumber}`)
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.click()
  await expect(page.getByTestId('admin-order-detail')).toBeVisible({ timeout: 15000 })
}

// P1-13 AC-10 and AC-11: the admin shows what was actually paid and refunded, from the order's stored amounts, and the
// admin API agrees at every step. Orders come from the storefront API (a `+stub-pending` order stays unpaid; any other
// email is paid inline by the stub), each journey its own. They replace the journey that confirmed a never-paid order
// and refunded it with no amount (decision 8).

interface PaymentRead {
  state: 'unpaid' | 'paid' | 'partially_refunded' | 'refunded'
  capturedMinor: number
  refundedMinor: number
  refundableMinor: number
  currency: string
  refunds: Array<{ id: string; amountMinor: number; status: string }>
}

interface OrderRead {
  orderNumber: string
  status: string
  totalMinor: number
  currency: string
  payment: PaymentRead
}

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

const LABEL: Record<PaymentRead['state'], RegExp> = {
  unpaid: /^\s*Unpaid\s*$/i,
  paid: /^\s*Paid\s*$/i,
  partially_refunded: /^\s*Partially refunded\s*$/i,
  refunded: /^\s*Refunded\s*$/i,
}

/** An email the stub pays inline (no `+stub-pending`), unique to one journey. */
function paidEmail(kind: string): string {
  return `e2e-p1-13-${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`
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

/** The detail page's Payment panel agrees with the admin API's read of the same order. */
async function expectPaymentPanel(page: Page, read: OrderRead): Promise<void> {
  const { payment } = read
  await expect(page.getByTestId('admin-order-payment-state')).toHaveText(LABEL[payment.state], {
    timeout: 15_000,
  })
  await expect(page.getByTestId('admin-order-captured')).toHaveText(
    endsWithAmount(payment.capturedMinor, payment.currency),
  )
  await expect(page.getByTestId('admin-order-refunded')).toHaveText(
    endsWithAmount(payment.refundedMinor, payment.currency),
  )
  await expect(page.getByTestId('admin-order-net')).toHaveText(
    endsWithAmount(payment.capturedMinor - payment.refundedMinor, payment.currency),
  )
}

async function openDetail(page: Page, orderNumber: string): Promise<void> {
  await page.goto(`orders/${orderNumber}`)
  await expect(page.getByTestId('admin-order-detail')).toContainText(orderNumber, {
    timeout: 15_000,
  })
}

/** The refund dialog, by amount only (decision 8), entered in major units as the admin enters prices. */
async function refundThroughDialog(page: Page, amountMinor: number): Promise<void> {
  await page.getByTestId('admin-order-actions').click()
  await page.getByTestId('admin-order-action-refund').click()
  const dialog = page.getByTestId('admin-order-refund-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('admin-order-refund-amount').fill((amountMinor / 100).toFixed(2))
  await page.getByTestId('admin-order-refund-reason').fill('Returned by the customer')
  await page.getByTestId('admin-order-refund-confirm').click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
}

test.describe('Admin orders', () => {
  // Kills: "Paid" read from the intent every order has from checkout start, and Captured shown as the order total
  // whatever was paid.
  test('AC-10: a +stub-pending order shows Unpaid with Captured 0 and offers neither a refund nor confirmed; a paid stub order shows Paid with Captured = its total; the list Payment column agrees for both', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const unpaid = await placeOrder(request)
    // A second shopper, with a cart of their own: from the same cart the paid checkout would supersede the pending order.
    const shopper = await playwrightRequest.newContext()
    let paid: Awaited<ReturnType<typeof placeOrder>>
    try {
      paid = await placeOrder(shopper, paidEmail('paid'))
    } finally {
      await shopper.dispose()
    }
    const token = await adminToken(request)
    const unpaidRead = await readOrder(request, token, unpaid.orderNumber)
    const paidRead = await readOrder(request, token, paid.orderNumber)
    expect(unpaidRead.payment?.state).toBe('unpaid')
    expect(unpaidRead.payment?.capturedMinor).toBe(0)
    expect(paidRead.payment?.state).toBe('paid')
    expect(paidRead.payment?.capturedMinor).toBe(paidRead.totalMinor)

    await signInAsAdmin(page)
    await openDetail(page, unpaid.orderNumber)
    await expectPaymentPanel(page, unpaidRead)
    await page.getByTestId('admin-order-actions').click()
    await expect(page.getByTestId('admin-order-action-refund')).toHaveCount(0)
    await page.keyboard.press('Escape')
    // A pending order is confirmed by recording a payment, never by the status select (M5).
    await page.getByTestId('admin-order-status-select').click()
    await expect(page.getByTestId('admin-order-status-option-confirmed')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await openDetail(page, paid.orderNumber)
    await expectPaymentPanel(page, paidRead)
    await expect(page.getByTestId('admin-order-captured')).toHaveText(
      endsWithAmount(paidRead.totalMinor, paidRead.currency),
    )

    await page.goto('orders')
    for (const read of [unpaidRead, paidRead]) {
      await page.getByPlaceholder('Search orders...').fill(read.orderNumber)
      await expect(page.getByTestId(`admin-orders-payment-${read.orderNumber}`)).toHaveText(
        LABEL[read.payment.state],
        { timeout: 15_000 },
      )
    }
  })

  // Kills: a refund that changes only the label (no amount moved or shown), and a page that disagrees with the API.
  test('AC-11: a partial refund shows Partially refunded, Refunded = the amount, Net = captured − refunded and a refund row; refunding the rest shows Refunded with Net 0; GET /api/admin/orders/:n agrees at each step and after a reload', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const order = await placeOrder(request, paidEmail('refund'))
    const token = await adminToken(request)
    const start = await readOrder(request, token, order.orderNumber)
    const captured = start.payment?.capturedMinor
    expect(captured).toBe(start.totalMinor)
    const part = Math.max(1, Math.floor(captured / 3))
    expect(part).toBeLessThan(captured)

    await signInAsAdmin(page)
    await openDetail(page, order.orderNumber)
    await expectPaymentPanel(page, start)

    await refundThroughDialog(page, part)

    const afterPart = await readOrder(request, token, order.orderNumber)
    expect(afterPart.payment.state).toBe('partially_refunded')
    expect(afterPart.payment.refundedMinor).toBe(part)
    expect(afterPart.payment.capturedMinor).toBe(captured)
    expect(afterPart.payment.refundableMinor).toBe(captured - part)
    expect(afterPart.payment.refunds.map((r) => [r.amountMinor, r.status])).toEqual([
      [part, 'succeeded'],
    ])
    await expectPaymentPanel(page, afterPart)
    await expect(
      page.getByTestId(`admin-order-refund-row-${afterPart.payment.refunds[0]!.id}`),
    ).toContainText(money(part, afterPart.payment.currency))

    await refundThroughDialog(page, captured - part)

    const afterAll = await readOrder(request, token, order.orderNumber)
    expect(afterAll.payment.state).toBe('refunded')
    expect(afterAll.payment.refundedMinor).toBe(captured)
    expect(afterAll.payment.refundableMinor).toBe(0)
    expect(afterAll.status).toBe('refunded')
    await expectPaymentPanel(page, afterAll)
    await expect(page.getByTestId('admin-order-net')).toHaveText(
      endsWithAmount(0, afterAll.payment.currency),
    )
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Refunded')
    for (const refund of afterAll.payment.refunds) {
      await expect(page.getByTestId(`admin-order-refund-row-${refund.id}`)).toContainText(
        money(refund.amountMinor, afterAll.payment.currency),
      )
    }

    // After a full reload the page comes from the API's stored amounts, not the client's cache.
    await page.reload()
    await expect(page.getByTestId('admin-order-detail')).toContainText(order.orderNumber, {
      timeout: 15_000,
    })
    await expectPaymentPanel(page, await readOrder(request, token, order.orderNumber))
  })

  test('orders list page is accessible @a11y', async ({ page, request }) => {
    test.setTimeout(60_000)
    const { orderNumber } = await createPendingOrder(request)
    await loginAsAdmin(page)
    await page.getByTestId('admin-nav-orders').click()
    await expect(page.getByTestId(`admin-orders-row-${orderNumber}`)).toBeVisible({
      timeout: 15000,
    })
    const AxeBuilder = (await import('@axe-core/playwright')).default
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })

  test('order detail page is accessible @a11y', async ({ page, request }) => {
    test.setTimeout(60_000)
    const { orderNumber } = await createPendingOrder(request)
    await loginAsAdmin(page)
    await openOrderDetail(page, orderNumber)
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Pending')
    const AxeBuilder = (await import('@axe-core/playwright')).default
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })
})
