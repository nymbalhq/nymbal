import type { APIRequestContext, Page } from '@playwright/test'
import { expect } from './fixtures'
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
 * A real pending order through the API: a seeded in-stock variant into a cart, then checkout (native-stub). The email's
 * `+stub-pending` keeps the order pending; without it the stub pays inline.
 */
export async function placeOrder(
  request: APIRequestContext,
  email = `e2e-admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}+stub-pending@nymbal.dev`,
): Promise<{ orderId: string; orderNumber: string }> {
  const productsRes = await request.get(`${API_URL}/api/products?limit=50`)
  expect(productsRes.ok(), 'GET /api/products').toBe(true)
  const products = (
    (await productsRes.json()) as {
      data: {
        items: Array<{ status?: string; variants?: Array<{ id: string; stock?: number }> }>
      }
    }
  ).data.items
  let added = false
  for (const product of products) {
    // The storefront lists drafts too: a draft is a journey's own fixture, whose stock no other journey may move.
    if (product.status === 'draft') continue
    const variant = product.variants?.find((v) => (v.stock ?? 1) > 0)
    if (!variant) continue
    const addRes = await request.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(request),
      data: { variantId: variant.id, qty: 1 },
    })
    if (addRes.ok()) {
      added = true
      break
    }
  }
  expect(added, 'a seeded in-stock variant added to the cart').toBe(true)

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
