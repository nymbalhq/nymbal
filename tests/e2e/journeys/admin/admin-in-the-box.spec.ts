import { request as playwrightRequest } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { API_URL, csrf } from '../../support/csrf'
import {
  SHIPPING_ADDRESS,
  adminShellSeen,
  placeOrder,
  realtimeConnected,
  signInAsAdmin,
  watchAdminShell,
  watchRealtime,
} from '../../support/admin'

// P1-08 acceptance journeys: the admin as `nymbal dev --api-only` serves it at <api>/admin/ (baseURL), one origin with
// /api, so the httpOnly `nymbal.refresh` cookie and the admin's relative URLs work without a proxy.
// AC-1 kills: the client listening on the wrong event names or reading `data`; a handler reading `order.orderNumber`
// off `{ order }`. AC-5 kills: the token only in memory. AC-6 kills: a restore that trusts any refresh. AC-8 kills: a
// logout that clears memory only, so restore signs back in. AC-15 kills: the admin's own Address (line1/state).

const REFRESH_COOKIE = 'nymbal.refresh'
const path = (url: string): string => new URL(url).pathname

test.describe('P1-08 admin in the box', () => {
  test('AC-1: an order placed through the API appears on the open orders list within 15 s, with no reload or navigation, and the New Order notification names it', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    await watchRealtime(page)
    await signInAsAdmin(page)
    const listLoaded = page.waitForResponse(
      (r) => path(r.url()) === '/api/admin/orders' && r.request().method() === 'GET',
    )
    await page.getByTestId('admin-nav-orders').click()
    await listLoaded
    await realtimeConnected(page)

    const listUrl = page.url()
    let loads = 0
    page.on('load', () => {
      loads += 1
    })

    const { orderNumber } = await placeOrder(request)

    const row = page.getByTestId(`admin-orders-row-${orderNumber}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toContainText(orderNumber)
    expect(loads).toBe(0)
    expect(page.url()).toBe(listUrl)

    await page.getByRole('button', { name: 'Notifications' }).click()
    const newOrder = page
      .getByRole('dialog')
      .locator('div')
      .filter({ hasText: 'New Order' })
      .filter({ hasText: orderNumber })
    await expect(newOrder.first()).toBeVisible()
    expect(await newOrder.count()).toBeGreaterThan(0)
  })

  test('AC-5: a reload of /admin/orders, and of a deep link to an order, keeps the session: the URL never becomes /admin/login and the known order renders', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const { orderNumber } = await placeOrder(request)
    await signInAsAdmin(page)
    await page.getByTestId('admin-nav-orders').click()
    await expect(page.getByTestId(`admin-orders-row-${orderNumber}`)).toBeVisible({
      timeout: 15_000,
    })

    const visited: string[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visited.push(path(frame.url()))
    })

    await page.reload()
    await expect(page.getByTestId(`admin-orders-row-${orderNumber}`)).toBeVisible({
      timeout: 15_000,
    })

    await page.goto(`orders/${orderNumber}`)
    await expect(page.getByTestId('admin-order-detail')).toContainText(orderNumber, {
      timeout: 15_000,
    })
    await page.reload()
    await expect(page.getByTestId('admin-order-detail')).toContainText(orderNumber, {
      timeout: 15_000,
    })

    expect(visited.length).toBeGreaterThanOrEqual(3)
    expect(visited.filter((p) => /^\/admin\/login\/?$/.test(p))).toEqual([])
  })

  test('AC-6: a valid refresh cookie for a customer-role account boots to /login, renders no admin page and makes no admin call beyond the role check', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await watchAdminShell(page)
    const email = `e2e-p1-08-customer-${Date.now()}@nymbal.dev`
    const registered = await page.request.post(`${API_URL}/api/auth/register`, {
      headers: await csrf(page.request),
      data: { email, password: 'customer-password-123' },
    })
    expect(registered.status(), await registered.text()).toBe(201)
    const cookies = await page.context().cookies(API_URL)
    expect(cookies.map((c) => c.name)).toContain(REFRESH_COOKIE)

    const apiCalls: string[] = []
    const refreshStatuses: number[] = []
    page.on('request', (r) => {
      if (path(r.url()).startsWith('/api/')) apiCalls.push(`${r.method()} ${path(r.url())}`)
    })
    page.on('response', (r) => {
      if (path(r.url()) === '/api/auth/refresh') refreshStatuses.push(r.status())
    })

    await page.goto('orders')
    await expect(page).toHaveURL(/\/admin\/login\/?$/, { timeout: 15_000 })
    await expect(page.getByTestId('admin-login-form')).toBeVisible()
    await page.waitForLoadState('networkidle')

    expect(refreshStatuses).toEqual([200])
    expect(apiCalls.filter((c) => c.includes(' /api/admin/'))).toEqual(['GET /api/admin/me'])
    expect(await adminShellSeen(page)).toBe(false)
  })

  test('AC-8: logout sends POST /api/auth/logout; afterwards a reload and a protected route show /login, and the old refresh cookie is refused', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await signInAsAdmin(page)
    const before = (await page.context().cookies(API_URL)).find((c) => c.name === REFRESH_COOKIE)
    expect(before?.value.length ?? 0, 'refresh cookie after sign-in').toBeGreaterThan(0)

    const logout = page.waitForRequest(
      (r) => r.method() === 'POST' && path(r.url()) === '/api/auth/logout',
      { timeout: 10_000 },
    )
    await page.getByRole('button', { name: 'Sign out' }).click()
    const sent = await logout
    expect((await sent.response())?.status()).toBe(200)

    await page.reload()
    await expect(page).toHaveURL(/\/admin\/login\/?$/, { timeout: 15_000 })
    await page.goto('orders')
    await expect(page).toHaveURL(/\/admin\/login\/?$/, { timeout: 15_000 })
    await expect(page.getByTestId('admin-nav-orders')).toHaveCount(0)

    const outsider = await playwrightRequest.newContext()
    try {
      const replay = await outsider.post(`${API_URL}/api/auth/refresh`, {
        headers: await csrf(outsider),
        data: { refreshToken: before!.value },
      })
      expect(replay.status(), await replay.text()).toBeGreaterThanOrEqual(400)
      expect(replay.status()).toBeLessThan(500)
    } finally {
      await outsider.dispose()
    }
  })

  test('AC-15: the order detail page shows the shipping addressLine1, city, region and postalCode of a real order, and no undefined', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000)
    const { orderNumber } = await placeOrder(request)
    await signInAsAdmin(page)
    await page.getByTestId('admin-nav-orders').click()
    await page.getByTestId(`admin-orders-row-${orderNumber}`).click({ timeout: 15_000 })
    const detail = page.getByTestId('admin-order-detail')
    await expect(detail).toContainText(orderNumber, { timeout: 15_000 })

    for (const field of ['addressLine1', 'city', 'region', 'postalCode'] as const) {
      await expect(detail, field).toContainText(SHIPPING_ADDRESS[field])
    }
    const text = (await detail.innerText()).toLowerCase()
    expect(text.split('undefined').length - 1).toBe(0)
  })
})
