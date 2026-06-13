import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'

const API_URL = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'
const ADMIN_EMAIL = process.env.NYMBAL_ADMIN_EMAIL ?? 'admin@nymbal.local'
const ADMIN_PASSWORD = process.env.NYMBAL_ADMIN_PASSWORD ?? 'nymbal-admin-dev'

// Canonical Address shape from @nymbal/types (firstName/lastName/addressLine1/region).
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
      data: { variantId, qty: 1 },
    })
    if (addRes.ok()) {
      added = true
      break
    }
  }
  expect(added, 'a seeded variant should be added to the cart').toBe(true)

  const checkoutRes = await request.post(`${API_URL}/api/checkout`, {
    data: {
      email: 'e2e-admin-orders@nymbal.dev',
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

async function adminAccessToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  expect(res.ok(), 'admin API login should succeed').toBe(true)
  const body = (await res.json()) as { data: { accessToken: string } }
  return body.data.accessToken
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

test.describe('Admin orders', () => {
  test('view order, change status, and refund end-to-end', async ({ page, request }) => {
    test.setTimeout(180_000)
    const { orderId, orderNumber } = await createPendingOrder(request)

    await loginAsAdmin(page)
    await openOrderDetail(page, orderNumber)
    const badge = page.getByTestId('admin-order-status-badge')
    await expect(badge).toHaveText('Pending')

    // pending → confirmed via the status select
    await page.getByTestId('admin-order-status-select').click()
    await page.getByTestId('admin-order-status-option-confirmed').click()
    await expect(badge).toHaveText('Confirmed', { timeout: 15000 })
    await page.getByTestId('admin-order-tab-timeline').click()
    await expect(page.getByTestId('admin-order-timeline-entry-pending')).toBeVisible({
      timeout: 15000,
    })
    await expect(page.getByTestId('admin-order-timeline-entry-confirmed')).toBeVisible({
      timeout: 15000,
    })

    // confirmed → processing via the status select
    await page.getByTestId('admin-order-status-select').click()
    await page.getByTestId('admin-order-status-option-processing').click()
    await expect(badge).toHaveText('Processing', { timeout: 15000 })
    await expect(page.getByTestId('admin-order-timeline-entry-processing')).toBeVisible({
      timeout: 15000,
    })

    // processing → shipped via the admin API (the ship action requires
    // tracking details the status select does not collect)
    const token = await adminAccessToken(request)
    const shipRes = await request.post(`${API_URL}/api/admin/orders/${orderId}/ship`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { trackingNumber: 'TRK-E2E-0001', carrier: 'DHL' },
    })
    expect(shipRes.ok(), 'POST /api/admin/orders/:id/ship should succeed').toBe(true)

    await page.reload()
    await loginAsAdmin(page)
    await openOrderDetail(page, orderNumber)
    await expect(badge).toHaveText('Shipped')

    // shipped → delivered via the status select
    await page.getByTestId('admin-order-status-select').click()
    await page.getByTestId('admin-order-status-option-delivered').click()
    await expect(badge).toHaveText('Delivered', { timeout: 15000 })
    await page.getByTestId('admin-order-tab-timeline').click()
    await expect(page.getByTestId('admin-order-timeline-entry-shipped')).toBeVisible({
      timeout: 15000,
    })
    await expect(page.getByTestId('admin-order-timeline-entry-delivered')).toBeVisible({
      timeout: 15000,
    })

    // delivered → refunded via the actions menu + refund dialog
    await page.getByTestId('admin-order-actions').click()
    await page.getByTestId('admin-order-action-refund').click()
    await expect(page.getByTestId('admin-order-refund-dialog')).toBeVisible()
    await page.getByTestId('admin-order-refund-reason').fill('Customer returned the parcel')
    await page.getByTestId('admin-order-refund-confirm').click()
    await expect(page.getByTestId('admin-order-refund-dialog')).toBeHidden({ timeout: 15000 })
    await expect(badge).toHaveText('Refunded', { timeout: 15000 })
    await expect(page.getByTestId('admin-order-timeline-entry-refunded')).toBeVisible({
      timeout: 15000,
    })

    // Full reload: the refunded state must come back from the API read
    // model, not from client-side cache.
    await page.reload()
    await loginAsAdmin(page)
    await openOrderDetail(page, orderNumber)
    await expect(badge).toHaveText('Refunded')
    await page.getByTestId('admin-order-tab-timeline').click()
    await expect(page.getByTestId('admin-order-timeline-entry-delivered')).toBeVisible()
    await expect(page.getByTestId('admin-order-timeline-entry-refunded')).toBeVisible()
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
    const results = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('order detail page is accessible @a11y', async ({ page, request }) => {
    test.setTimeout(60_000)
    const { orderNumber } = await createPendingOrder(request)
    await loginAsAdmin(page)
    await openOrderDetail(page, orderNumber)
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Pending')
    const AxeBuilder = (await import('@axe-core/playwright')).default
    const results = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})
