import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { adminToken, openCheckout, ownProduct, walkToPayment } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { storageHolding, watchAccessTokens } from '../support/session'
import { signIn } from '../support/sign-in'

// AC-8 on both templates (the astro and nextjs projects run this file): the shopper's access token lives only in the
// page's memory, and a signed-in shopper stays signed in across page loads all the same. Reloading the account page
// shows their account; reloading the checkout and placing the order makes the order theirs; two pages of the same
// browser opened at once both end signed in (their two restores present one refresh cookie together), and a page
// opened after them still is. No localStorage or sessionStorage key or value ever holds an access token the API
// answered this browser.

const PASSWORD = 'TestPassword123!'
const onAccountHome = (url: URL) => url.pathname.replace(/\/$/, '') === '/account'

async function registeredShopper(request: APIRequestContext): Promise<string> {
  const email = `e2e-memory-${randomUUID().slice(0, 8)}@e2e.test`
  const res = await request.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(request),
    data: { email, password: PASSWORD, firstName: 'Memory', lastName: 'Shopper' },
  })
  expect(res.status(), `POST /api/auth/register: ${await res.text()}`).toBe(201)
  return email
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

/** The account page shows the shopper's own email, not the sign-in page. */
async function expectSignedIn(page: Page, email: string, what: string): Promise<void> {
  await expect(page.getByTestId('account-dashboard'), what).toContainText(email, {
    timeout: 15_000,
  })
  expect(onAccountHome(new URL(page.url())), `${what}: still on /account`).toBe(true)
}

test.describe('AC-8: the access token in memory, the shopper still signed in', () => {
  // Kills: a token in Web Storage (any script reads it); memory storage with no restore, so a reload redirects to
  // sign-in or places the order as a guest.
  test('AC-8: a signed-in shopper reloads the account and the checkout and is still signed in, the order placed after the reload is listed in their account, and no Web Storage value holds an access token', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const product = await ownProduct(request, await adminToken(request), 5)
    const email = await registeredShopper(request)
    const tokens = watchAccessTokens(page.context())

    await signIn(page, email, PASSWORD)
    await page.waitForURL(onAccountHome, { timeout: 15_000 })
    await page.reload()
    await expectSignedIn(page, email, 'the account after a reload')
    expect(await storageHolding(page, await tokens.all()), 'Web Storage after a reload').toEqual([])

    await openCheckout(page, product)
    // The product's slug starts with "checkout", so the helper's URL wait can pass on the product page itself.
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/checkout')
    await page.reload()
    await page.waitForLoadState('load')
    await walkToPayment(page, email)
    await page.getByTestId('place-order').click()
    await page.waitForURL((url) => /^\/(account\/orders|order)\/[^/]+\/?$/.test(url.pathname), {
      timeout: 20_000,
    })
    const placed = /^\/(account\/orders|order)\/([^/]+)\/?$/.exec(new URL(page.url()).pathname)!

    expect(placed[1], 'a signed-in checkout lands on the account’s order page').toBe(
      'account/orders',
    )
    expect(await accountOrders(request, email), 'the account’s orders').toEqual([
      decodeURIComponent(placed[2]!),
    ])
    const issued = await tokens.all()
    expect(issued.length, 'access tokens the API answered').toBeGreaterThan(0)
    expect(await storageHolding(page, issued), 'Web Storage after the order').toEqual([])
  })

  // Kills: two tabs restoring together revoking the session (the second presents the refresh cookie the first just
  // rotated), so one or both pages, or every page after them, read as signed out.
  test('AC-8: two pages of the same browser opened at once both end signed in, a page opened after them is still signed in, and no Web Storage value holds an access token', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const email = await registeredShopper(request)
    const context = page.context()
    const tokens = watchAccessTokens(context)
    await signIn(page, email, PASSWORD)
    await page.waitForURL(onAccountHome, { timeout: 15_000 })
    const [first, second] = [await context.newPage(), await context.newPage()]

    await Promise.all([first.goto('/account'), second.goto('/account')])
    await expectSignedIn(first, email, 'the first of the two pages')
    await expectSignedIn(second, email, 'the second of the two pages')
    const after = await context.newPage()
    await after.goto('/account')

    await expectSignedIn(after, email, 'a page opened after them')
    const issued = await tokens.all()
    expect(issued.length, 'access tokens the API answered').toBeGreaterThan(0)
    expect(await storageHolding(after, issued), 'Web Storage').toEqual([])
  })
})
