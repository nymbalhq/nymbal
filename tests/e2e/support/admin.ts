import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { expect } from './fixtures'
import { adminToken, ownProduct } from './checkout'
import { API_URL, csrf } from './csrf'

// Helpers for the admin journeys that `nymbal dev --api-only` serves at <api>/admin/ (one origin with /api).

export const ADMIN_EMAIL = process.env.NYMBAL_ADMIN_EMAIL ?? 'admin@nymbal.local'
export const ADMIN_PASSWORD = process.env.NYMBAL_ADMIN_PASSWORD ?? 'nymbal-admin-dev'

/** Every field distinct, so a page that renders one field in place of another cannot pass. */
export const SHIPPING_ADDRESS = {
  firstName: 'Avery',
  lastName: 'Quinn',
  addressLine1: '42 Harbour Lane',
  city: 'Bristol',
  region: 'Avon',
  postalCode: 'BS1 4DJ',
  country: 'GB',
}

/**
 * A real pending order through the API: a product of its own into a cart, then checkout (native-stub). The product is
 * the order's own, so this never moves the stock of a product another journey asserts on. The email's `+stub-pending`
 * keeps the order pending; without it the stub pays inline.
 */
export async function placeOrder(
  request: APIRequestContext,
  email = `e2e-admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}+stub-pending@nymbal.dev`,
): Promise<{ orderId: string; orderNumber: string }> {
  // The admin signs in on a context of its own, so the checkout below stays the caller's (a guest's).
  const admin = await playwrightRequest.newContext()
  let variantId: string
  try {
    variantId = (await ownProduct(admin, await adminToken(admin), 1)).variantId
  } finally {
    await admin.dispose()
  }

  const addRes = await request.post(`${API_URL}/api/cart/items`, {
    headers: await csrf(request),
    data: { variantId, qty: 1 },
  })
  expect(addRes.ok(), `POST /api/cart/items: ${await addRes.text()}`).toBe(true)

  const checkoutRes = await request.post(`${API_URL}/api/checkout`, {
    headers: await csrf(request),
    data: { email, billingAddress: SHIPPING_ADDRESS, shippingAddress: SHIPPING_ADDRESS },
  })
  expect(checkoutRes.ok(), `POST /api/checkout: ${await checkoutRes.text()}`).toBe(true)
  const body = (await checkoutRes.json()) as { data: { orderId: string; orderNumber: string } }
  return { orderId: body.data.orderId, orderNumber: body.data.orderNumber }
}

/**
 * Signs in through the admin's login form and waits for the shell: the admin at the page's base URL, or the one at
 * `adminBase` (a storefront journey's API, whose admin is not at the storefront's base).
 */
export async function signInAsAdmin(page: Page, adminBase?: string): Promise<void> {
  const served = await page.goto(
    adminBase === undefined ? 'login' : new URL('login', adminBase).href,
  )
  expect(served?.status(), `GET ${page.url()}: is the admin served here?`).toBe(200)
  await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
  await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
  await page.getByTestId('admin-login-submit').click()
  await expect(page.getByTestId('admin-nav-orders')).toBeVisible({ timeout: 15_000 })
}

/** Counts the admin's realtime connections that the server has confirmed (`event: connected`) in `window`. */
export async function watchRealtime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.EventSource
    const w = window as unknown as { __nymbalSseConnected?: number }
    class Watched extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        this.addEventListener('connected', () => {
          w.__nymbalSseConnected = (w.__nymbalSseConnected ?? 0) + 1
        })
      }
    }
    window.EventSource = Watched
  })
}

export async function realtimeConnected(page: Page): Promise<void> {
  await page.waitForFunction(
    () => ((window as unknown as { __nymbalSseConnected?: number }).__nymbalSseConnected ?? 0) > 0,
    null,
    { timeout: 15_000 },
  )
}

/** Flags, in `window`, any admin shell element (a sidebar nav link) that is ever attached, even briefly. */
export async function watchAdminShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __nymbalAdminShellSeen?: boolean }
    const check = () => {
      if (document.querySelector('[data-testid^="admin-nav-"]')) w.__nymbalAdminShellSeen = true
    }
    new MutationObserver(check).observe(document, { childList: true, subtree: true })
  })
}

export async function adminShellSeen(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __nymbalAdminShellSeen?: boolean }).__nymbalAdminShellSeen === true,
  )
}
