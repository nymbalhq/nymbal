import { randomUUID } from 'node:crypto'
import {
  devices,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { ADMIN_EMAIL, ADMIN_PASSWORD, placeOrder, signInAsAdmin } from '../../support/admin'
import { API_URL, csrf } from '../../support/csrf'
import { adminToken, ownProduct, type OwnProduct } from '../../support/checkout'

// AC-2 and AC-3: at Pixel 7 (412 px) a merchant uses the admin without sideways scrolling, and the sidebar folds
// behind a menu button below `md`. The viewport is set here, not by the `@visual`-only admin-mobile project.
// `defaultBrowserType` cannot be set per describe; the project's chromium is the same browser.
const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7']

interface Fixture {
  product: OwnProduct
  orderNumber: string
  /** Unpaid: its header carries the Record payment button and the status select a paid order lacks. */
  pendingOrderNumber: string
  customerId: string
  customerEmail: string
}

/** A product of this test's own, and a registered customer's order for it, so every page has real rows to lay out. */
async function seed(request: APIRequestContext): Promise<Fixture> {
  const product = await ownProduct(request, await adminToken(request), 5)
  const tag = randomUUID().slice(0, 8)
  // 45 characters with no hyphen or space, so nothing but the page's own wrapping keeps it inside 412 px.
  const customerEmail = `phonewidthshopper${tag}${tag}@example.com`
  const shopper = await playwrightRequest.newContext()
  try {
    const reg = await shopper.post(`${API_URL}/api/auth/register`, {
      headers: await csrf(shopper),
      data: {
        email: customerEmail,
        password: 'TestPassword123!',
        firstName: `Wren${tag}`,
        lastName: 'Phonewidth',
      },
    })
    expect(reg.ok(), `POST /api/auth/register: ${await reg.text()}`).toBe(true)
    const { customer, accessToken } = (
      (await reg.json()) as { data: { customer: { id: string }; accessToken: string } }
    ).data
    const auth = { authorization: `Bearer ${accessToken}` }
    const add = await shopper.post(`${API_URL}/api/cart/items`, {
      headers: { ...(await csrf(shopper)), ...auth },
      data: { variantId: product.variantId, qty: 1 },
    })
    expect(add.ok(), `POST /api/cart/items: ${await add.text()}`).toBe(true)
    const address = {
      firstName: 'Wren',
      lastName: 'Phonewidth',
      addressLine1: '7 Narrow Street',
      city: 'Bristol',
      region: 'Avon',
      postalCode: 'BS1 5TT',
      country: 'GB',
    }
    const checkout = await shopper.post(`${API_URL}/api/checkout`, {
      headers: { ...(await csrf(shopper)), ...auth },
      data: { email: customerEmail, billingAddress: address, shippingAddress: address },
    })
    expect(checkout.ok(), `POST /api/checkout: ${await checkout.text()}`).toBe(true)
    const { orderNumber } = ((await checkout.json()) as { data: { orderNumber: string } }).data
    // A cart of its own: from the shopper's cart this checkout would supersede the paid order.
    const guest = await playwrightRequest.newContext()
    try {
      const pending = await placeOrder(guest)
      return {
        product,
        orderNumber,
        pendingOrderNumber: pending.orderNumber,
        customerId: customer.id,
        customerEmail,
      }
    } finally {
      await guest.dispose()
    }
  } finally {
    await shopper.dispose()
  }
}

/**
 * Signs in through the login form and waits for the shell's `main`. Not `signInAsAdmin`: that waits for a visible
 * sidebar link, which a closed off-canvas sidebar may rightly hide.
 */
async function signIn(page: Page): Promise<void> {
  const served = await page.goto('login')
  expect(served?.status(), `GET ${page.url()}: is the admin served here?`).toBe(200)
  await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
  await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
  await page.getByTestId('admin-login-submit').click()
  await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
    timeout: 15_000,
  })
  await expect(page.locator('main')).toBeVisible({ timeout: 15_000 })
}

async function widths(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
}

test.describe('Admin at Pixel 7', () => {
  test.use(pixel7)

  test('AC-2: dashboard, orders, a paid and a pending order detail, products, product detail, new product, inventory, customers and customer detail are each no wider than the viewport', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const seeded = await seed(request)
    await signIn(page)

    const main = page.locator('main')
    // `answer`: an API path the page fetches, awaited when the page has no rendered data to wait on.
    const pages: Array<{
      name: string
      path: string
      ready: () => Promise<void>
      answer?: string
    }> = [
      {
        name: 'dashboard',
        path: '',
        ready: () => expect(main.getByRole('heading', { name: 'Recent Orders' })).toBeVisible(),
      },
      {
        name: 'orders',
        path: 'orders',
        ready: () =>
          expect(page.getByTestId(`admin-orders-row-${seeded.orderNumber}`)).toBeVisible(),
      },
      {
        name: 'order detail',
        path: `orders/${encodeURIComponent(seeded.orderNumber)}`,
        ready: () =>
          expect(page.getByTestId('admin-order-detail')).toContainText(seeded.orderNumber),
      },
      {
        name: 'pending order detail',
        path: `orders/${encodeURIComponent(seeded.pendingOrderNumber)}`,
        ready: () =>
          expect(
            page.getByTestId('admin-order-detail').getByRole('button', { name: 'Record payment' }),
          ).toBeVisible(),
      },
      {
        name: 'products',
        path: 'products',
        ready: () =>
          expect(page.locator('[data-testid^="admin-products-row-"]').first()).toBeVisible(),
      },
      {
        name: 'product detail',
        path: `products/${seeded.product.slug}`,
        // The admin API has no GET /api/admin/products/:slug today, so the form stays empty: measured once it answers.
        answer: `/api/admin/products/${seeded.product.slug}`,
        ready: () => expect(page.getByTestId('admin-product-name')).toBeEditable(),
      },
      {
        name: 'new product',
        path: 'products/new',
        ready: () => expect(page.getByTestId('admin-product-name')).toBeEditable(),
      },
      {
        name: 'inventory',
        path: 'inventory',
        ready: () =>
          expect(page.locator('[data-testid^="admin-inventory-row-"]').first()).toBeVisible(),
      },
      {
        name: 'customers',
        path: 'customers',
        ready: () =>
          expect(page.getByTestId(`admin-customers-row-${seeded.customerId}`)).toBeVisible(),
      },
      {
        name: 'customer detail',
        path: `customers/${seeded.customerId}`,
        ready: () =>
          expect(page.getByTestId('admin-customer-detail')).toContainText(seeded.customerEmail),
      },
    ]

    const viewportWidth = pixel7.viewport.width
    for (const { name, path, ready, answer } of pages) {
      const answered =
        answer === undefined
          ? Promise.resolve()
          : page.waitForResponse((res) => new URL(res.url()).pathname === answer)
      await page.goto(path)
      await answered
      await ready()
      // Skeletons are placeholders of fixed size; the page is measured once its data has replaced them.
      await expect(main.locator('.animate-pulse')).toHaveCount(0, { timeout: 10_000 })
      const { scrollWidth, innerWidth } = await widths(page)
      // Mobile Chrome zooms out to fit a page wider than its viewport, which raises innerWidth to the page's width, so
      // scrollWidth ≤ innerWidth alone would pass on the defect: both are held to the device's 412.
      const measured = `${name}: scrollWidth ${scrollWidth}, innerWidth ${innerWidth}, Pixel 7 ${viewportWidth}`
      expect.soft(scrollWidth, measured).toBeLessThanOrEqual(viewportWidth)
      expect.soft(innerWidth, measured).toBe(viewportWidth)
    }
  })

  // Kills: Recent Orders in an `overflow-hidden` card with no scroll wrapper, which holds the page to 412 px (so the
  // test above passes) by clipping the Time column out of reach.
  test('AC-1: the dashboard’s Recent Orders is a focusable horizontal scroll region whose Time column, scrolled to the end, lies inside it, and axe finds no unfocusable scroll region', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const guest = await playwrightRequest.newContext()
    try {
      await placeOrder(guest)
    } finally {
      await guest.dispose()
    }
    await signIn(page)
    await page.goto('')

    const region = page.getByTestId('admin-dashboard-recent-orders')
    const time = region.getByRole('columnheader', { name: 'Time' })
    await expect(time).toBeAttached({ timeout: 15_000 })
    expect(await region.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto')

    await region.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    const box = await region.boundingBox()
    const header = await time.boundingBox()
    expect(box, 'the region has a box').not.toBeNull()
    expect(header, 'the Time header has a box').not.toBeNull()
    // Sub-pixel layout: half a pixel of rounding either way.
    expect(
      header!.x + header!.width,
      'Time header’s right edge vs the region’s',
    ).toBeLessThanOrEqual(box!.x + box!.width + 0.5)
    expect(header!.x, 'Time header’s left edge vs the region’s').toBeGreaterThanOrEqual(
      box!.x - 0.5,
    )

    await region.focus()
    await expect(region).toBeFocused()

    const AxeBuilder = (await import('@axe-core/playwright')).default
    const results = await new AxeBuilder({ page })
      .withRules(['scrollable-region-focusable'])
      .analyze()
    expect(results.violations.map((v) => v.nodes.map((n) => n.target))).toEqual([])
  })

  test('AC-3: the sidebar is closed on a phone, the menu button opens it, and choosing Orders lands on the orders list and closes it', async ({
    page,
  }) => {
    await signIn(page)
    const sidebar = page.getByTestId('admin-sidebar')
    const toggle = page.getByTestId('admin-nav-toggle')
    const ordersLink = page.getByTestId('admin-nav-orders')

    // Closed: the nav is off the screen, not a rail over the content.
    await expect(ordersLink).not.toBeInViewport()
    await expect(sidebar).toHaveAttribute('data-state', 'closed')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await toggle.tap()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(sidebar).toHaveAttribute('data-state', 'open')
    await expect(ordersLink).toBeInViewport()

    await ordersLink.tap()
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/admin/orders', {
      timeout: 10_000,
    })
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeInViewport()
    await expect(sidebar).toHaveAttribute('data-state', 'closed')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(ordersLink).not.toBeInViewport()

    // Below md, main and the top bar take the full width: the desktop 240 px offset would leave a 172 px column.
    const main = await page.locator('main').boundingBox()
    const topBar = await page.locator('header').filter({ has: toggle }).boundingBox()
    expect(main, 'main has a box').not.toBeNull()
    expect(topBar, 'the top bar has a box').not.toBeNull()
    expect(main!.x).toBe(0)
    expect(topBar!.x).toBe(0)
  })
})

test.describe('Admin at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false })

  test('AC-3: on desktop the sidebar is the 240 px rail with no menu button, and main keeps its 240 px offset', async ({
    page,
  }) => {
    await signInAsAdmin(page)
    const sidebar = page.getByTestId('admin-sidebar')
    await expect(sidebar).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('admin-nav-toggle')).toBeHidden()

    const rail = await sidebar.boundingBox()
    const main = await page.locator('main').boundingBox()
    expect(rail, 'the sidebar has a box').not.toBeNull()
    expect(main, 'main has a box').not.toBeNull()
    expect(rail!.x).toBe(0)
    expect(rail!.width).toBe(240)
    // main starts where the rail ends: the content is not under the sidebar, nor shifted further.
    expect(main!.x).toBe(rail!.x + rail!.width)
  })
})
