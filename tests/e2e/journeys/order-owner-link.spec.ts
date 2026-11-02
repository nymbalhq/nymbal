import { randomBytes, randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { adminToken, keyedOrderPath, ownProduct, shopperWithOrder } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { lapseStoredToken } from '../support/lapsed-token'
import { signIn } from '../support/sign-in'

// A signed-in shopper who opens `/order/<n>` of their own order without a working key lands on it in their account,
// on both templates (the astro and nextjs projects run this file). The order page's server cannot see the session (it
// lives in the browser's storage), so the page restores it, then reads the order as its owner; only that read
// answering sends the browser on, so an order of anyone else's stays the not-found state and the page says nothing
// about whether it exists.

const PASSWORD = 'TestPassword123!'
const REFRESH_COOKIE = 'nymbal.refresh'

const accountOrderPath = (orderNumber: string) =>
  `/account/orders/${encodeURIComponent(orderNumber)}`
const bareOrderPath = (orderNumber: string) => `/order/${encodeURIComponent(orderNumber)}`
const trimmed = (path: string) => path.replace(/\/$/, '')

/** A registered shopper with an order of their own, signed in through the storefront's form, on their account page. */
async function signedInOwner(page: Page, request: APIRequestContext) {
  const shopper = await shopperWithOrder(request, PASSWORD)
  await signIn(page, shopper.email, PASSWORD)
  await page.waitForURL((url) => trimmed(url.pathname) === '/account', { timeout: 15_000 })
  return shopper
}

/** A registered shopper with no orders, signed in through the storefront's form, on their account page. */
async function signedInShopper(page: Page, request: APIRequestContext): Promise<void> {
  const address = `e2e-owner-link-${randomUUID().slice(0, 8)}@e2e.test`
  const res = await request.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(request),
    data: { email: address, password: PASSWORD, firstName: 'Other', lastName: 'Shopper' },
  })
  expect(res.status(), `POST /api/auth/register: ${await res.text()}`).toBe(201)
  await signIn(page, address, PASSWORD)
  await page.waitForURL((url) => trimmed(url.pathname) === '/account', { timeout: 15_000 })
}

const GUEST_SHIPPING_LINE = '31 Guest Lane'

/** A guest order placed through the API from a context of its own, so no session or cart is shared. */
async function guestOrder(
  request: APIRequestContext,
): Promise<{ orderNumber: string; email: string }> {
  const product = await ownProduct(request, await adminToken(request), 5)
  const buyer = `e2e-owner-link-guest-${randomUUID().slice(0, 8)}@e2e.test`
  const added = await request.post(`${API_URL}/api/cart/items`, {
    headers: await csrf(request),
    data: { variantId: product.variantId, qty: 1 },
  })
  expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)
  const address = {
    firstName: 'Guest',
    lastName: 'Buyer',
    addressLine1: GUEST_SHIPPING_LINE,
    city: 'York',
    region: 'North Yorkshire',
    postalCode: 'YO1 7HH',
    country: 'GB',
  }
  const res = await request.post(`${API_URL}/api/checkout`, {
    headers: await csrf(request),
    data: { email: buyer, billingAddress: address, shippingAddress: address },
  })
  expect(res.ok(), `POST /api/checkout: ${await res.text()}`).toBe(true)
  const { orderNumber } = ((await res.json()) as { data: { orderNumber: string } }).data
  return { orderNumber, email: buyer }
}

/** Every URL the page's main frame has been at, from now on. */
function visited(page: Page): string[] {
  const urls: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url())
  })
  return urls
}

test.describe('A signed-in shopper at /order/<n>', () => {
  // Kills: an order page that never asks for the session, so the owner sees the not-found state; a redirect that keeps
  // the key, or one pushed onto the history, so Back returns to the not-found state.
  test('AC-7: the shopper who placed order n, opening /order/<n> and /order/<n>?key=<a key that opens nothing>, lands each time on /account/orders/<n> with no key, showing n in order-detail; Back returns to the page before, not the not-found state', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { orderNumber } = await signedInOwner(page, request)
    const before = new URL(page.url()).pathname

    const staleKey = randomBytes(32).toString('base64url')
    for (const path of [bareOrderPath(orderNumber), keyedOrderPath(orderNumber, staleKey)]) {
      await page.goto(path)
      await page.waitForURL((url) => url.pathname === accountOrderPath(orderNumber), {
        timeout: 15_000,
      })
      expect(
        new URL(page.url()).searchParams.has('key'),
        `${path}: a key in the account’s URL`,
      ).toBe(false)
      await expect(page.getByTestId('order-detail'), `${path}: the account’s order`).toContainText(
        orderNumber,
        { timeout: 15_000 },
      )

      await page.goBack({ waitUntil: 'load' })
      expect(trimmed(new URL(page.url()).pathname), `${path}: Back`).toBe(trimmed(before))
      await expect(page.getByTestId('order-link-number'), `${path}: Back`).toHaveCount(0)
    }
  })

  // Kills: the owner's read sent with the lapsed bearer before the session is restored: the route reads it as a guest's
  // and answers 404, and the SDK never refreshes.
  test('AC-8: the same shopper with their stored access token lapsed and the refresh cookie still valid, opening /order/<n>, lands on /account/orders/<n> showing n', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { orderNumber } = await signedInOwner(page, request)
    const refresh = (await page.context().cookies(API_URL)).find((c) => c.name === REFRESH_COOKIE)
    expect(refresh?.value.length ?? 0, 'the sign-in left a refresh cookie').toBeGreaterThan(0)
    await lapseStoredToken(page)

    await page.goto(bareOrderPath(orderNumber))
    await page.waitForURL((url) => url.pathname === accountOrderPath(orderNumber), {
      timeout: 15_000,
    })
    await expect(page.getByTestId('order-detail')).toContainText(orderNumber, { timeout: 15_000 })
  })

  // Kills: a check that sends every signed-in visit to the account's order page without the owner's read answering, so
  // the redirect itself says the order exists.
  test('AC-9: a signed-in shopper opening /order/<m> of another customer’s order, and of a guest’s, stays at /order/<m> on the not-found state with status 404, is never sent to /account/orders/<m>, and the page shows none of the order’s email or shipping line', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const customer = await shopperWithOrder(request, PASSWORD)
    const guest = await guestOrder(request)
    await signedInShopper(page, request)

    const others = [
      {
        whose: 'another customer’s',
        orderNumber: customer.orderNumber,
        secrets: [customer.email, '7 Narrow Street'],
      },
      {
        whose: 'a guest’s',
        orderNumber: guest.orderNumber,
        secrets: [guest.email, GUEST_SHIPPING_LINE],
      },
    ]
    for (const { whose, orderNumber, secrets } of others) {
      const urls = visited(page)
      const restored = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/customers/me' && r.status() === 200,
        { timeout: 15_000 },
      )
      const res = await page.goto(bareOrderPath(orderNumber))
      expect(res?.status(), `${whose} order: the page’s status`).toBe(404)
      await restored
      await page.waitForLoadState('networkidle')

      expect(
        urls.filter((u) => new URL(u).pathname === accountOrderPath(orderNumber)),
        `${whose} order: sent to the account’s order page`,
      ).toEqual([])
      expect(new URL(page.url()).pathname, `${whose} order: where the page is`).toBe(
        bareOrderPath(orderNumber),
      )
      await expect(
        page.getByTestId('order-link-number'),
        `${whose} order: the not-found state`,
      ).toBeVisible()
      const html = (await page.content()).toLowerCase()
      expect(
        secrets.filter((s) => html.includes(s.toLowerCase())),
        `${whose} order: its details in the page`,
      ).toEqual([])
    }
  })

  // Kills: a page that decodes the number it was handed once more, so a `%` in it throws and the error page replaces
  // the not-found state once the page hydrates.
  test('a signed-in shopper opening /order/<n> for a number with a percent sign in it stays at that path on the not-found state with status 404', async ({
    page,
    request,
  }) => {
    await signedInShopper(page, request)
    const path = bareOrderPath('50%')
    const restored = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/customers/me' && r.status() === 200,
      { timeout: 15_000 },
    )
    const res = await page.goto(path)
    expect(res?.status(), 'the page’s status').toBe(404)
    await restored
    await page.waitForLoadState('networkidle')

    expect(new URL(page.url()).pathname, 'where the page is').toBe(path)
    await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible()
    await expect(page.getByTestId('order-link-number')).toBeVisible()
  })
})
