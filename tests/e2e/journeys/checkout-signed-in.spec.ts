import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  adminToken,
  openCheckout,
  ordersFor,
  ownProduct,
  walkToPayment,
  type OwnProduct,
} from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { signIn } from '../support/sign-in'

// AC-9 on both templates (the astro and nextjs projects run this file): a signed-in shopper reaches Place Order with an
// access token the API no longer accepts, kept in localStorage as a lapsed one is across page loads. With the session's
// refresh cookie still there, the order is theirs: listed in their account, its page opened with no key. With the
// refresh cookie gone too, the session has ended: the page asks them to sign in again, places no order (a guest order
// would be missing from their account), and keeps the cart.

const PASSWORD = 'TestPassword123!'
const TOKEN_KEY = 'nymbal.auth.accessToken'
const REFRESH_COOKIE = 'nymbal.refresh'
const SESSION_EXPIRED = 'Your session has expired. Sign in again to place your order.'
const SIGN_IN = '/account/login?redirect=%2Fcheckout'

async function registeredShopper(request: APIRequestContext): Promise<string> {
  const email = `e2e-signed-in-${randomUUID().slice(0, 8)}@e2e.test`
  const res = await request.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(request),
    data: { email, password: PASSWORD, firstName: 'Signed', lastName: 'Shopper' },
  })
  expect(res.status(), `POST /api/auth/register: ${await res.text()}`).toBe(201)
  return email
}

/** Signs in through the storefront's form, then the product's page to a ready Place Order. */
async function signedInAtPayment(page: Page, product: OwnProduct, email: string): Promise<void> {
  await signIn(page, email, PASSWORD)
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
    timeout: 15_000,
  })
  await openCheckout(page, product)
  await walkToPayment(page, email)
}

/** The stored access token, its expiry put an hour in the past: a token the API refuses as it refuses a lapsed one. */
async function lapseStoredToken(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const token = localStorage.getItem(key)
    if (token === null) throw new Error('no access token is stored: is the shopper signed in?')
    const [header, payload, signature] = token.split('.')
    const claims = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp: number
    }
    claims.exp = Math.floor(Date.now() / 1000) - 3600
    const lapsed = btoa(JSON.stringify(claims))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
    localStorage.setItem(key, `${header}.${lapsed}.${signature}`)
  }, TOKEN_KEY)
}

/** The order numbers `GET /api/orders` lists for the customer, signed in afresh through the API. */
async function accountOrders(request: APIRequestContext, email: string): Promise<string[]> {
  const login = await request.post(`${API_URL}/api/auth/login`, {
    headers: await csrf(request),
    data: { email, password: PASSWORD },
  })
  expect(login.ok(), `POST /api/auth/login: ${await login.text()}`).toBe(true)
  const { accessToken } = ((await login.json()) as { data: { accessToken: string } }).data
  const res = await request.get(`${API_URL}/api/orders`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  expect(res.ok(), `GET /api/orders: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: Array<{ orderNumber: string }> }).data.map(
    (o) => o.orderNumber,
  )
}

/** Counts the page's POST /api/checkout requests from here on. */
function countCheckouts(page: Page): () => number {
  let sent = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/checkout') sent += 1
  })
  return () => sent
}

test.describe('A signed-in shopper whose access token lapsed at the payment step', () => {
  test('AC-9 (a): with the refresh cookie still valid, Place Order places the shopper’s own order: GET /api/orders with their session lists it, and its page opens with no key', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const product = await ownProduct(request, await adminToken(request), 5)
    const email = await registeredShopper(request)
    await signedInAtPayment(page, product, email)
    const refresh = (await page.context().cookies(API_URL)).find((c) => c.name === REFRESH_COOKIE)
    expect(refresh?.value.length ?? 0, 'the sign-in left a refresh cookie').toBeGreaterThan(0)

    await lapseStoredToken(page)
    await page.getByTestId('place-order').click()
    // A signed-in checkout lands on the account's order page, `/account/orders/<n>` (account-signed-in.spec.ts).
    const accountOrder = /^\/account\/orders\/([^/]+)\/?$/
    await page.waitForURL((url) => accountOrder.test(url.pathname), { timeout: 20_000 })
    const orderNumber = decodeURIComponent(accountOrder.exec(new URL(page.url()).pathname)![1]!)

    expect(await accountOrders(request, email), 'the account’s orders').toEqual([orderNumber])
    expect(new URL(page.url()).searchParams.get('key'), 'the order page’s key').toBeNull()
    await expect(page.getByTestId('order-detail')).toContainText(orderNumber, {
      timeout: 15_000,
    })
  })

  test('AC-9 (b): with the refresh cookie gone too, Place Order shows the session-expired message and the sign-in link, stays disabled so a second press sends nothing, places no order for the email, and the cart keeps its line', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const email = await registeredShopper(request)
    await signedInAtPayment(page, product, email)
    const checkouts = countCheckouts(page)

    await page.context().clearCookies({ name: REFRESH_COOKIE })
    await lapseStoredToken(page)
    const placeOrder = page.getByTestId('place-order')
    await placeOrder.click()

    await expect(page.getByTestId('checkout-error')).toHaveText(SESSION_EXPIRED, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('checkout-sign-in')).toHaveAttribute('href', SIGN_IN)
    await expect(placeOrder).toBeDisabled()
    // The second press: a disabled button takes no click, so nothing more may reach the API.
    await placeOrder.click({ force: true })
    await page.waitForLoadState('networkidle')
    expect(checkouts(), 'POST /api/checkout requests').toBe(1)
    expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe('/checkout')
    expect(await ordersFor(request, token, email), 'orders for the shopper’s email').toEqual([])
    const cart = await page.request.get(`${API_URL}/api/cart`)
    expect(cart.ok(), `GET /api/cart: ${await cart.text()}`).toBe(true)
    const lines = (
      (await cart.json()) as { data: { items: Array<{ variantId: string; qty: number }> } }
    ).data.items
    expect(lines.map((l) => [l.variantId, l.qty])).toEqual([[product.variantId, 1]])
  })
})
