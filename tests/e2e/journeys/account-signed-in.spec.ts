import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../support/fixtures'
import { adminToken, ownProduct } from '../support/checkout'
import { csrf } from '../support/csrf'

// AC-5, AC-6 and AC-7: a shopper who signs in sees their own account on either storefront, and signing out really
// signs them out. Both template projects run this file. Selectors are the data-testid contract both templates share
// (templates/CLAUDE.md); the account navigation is found by its aria-label, which both carry.

const API = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'

interface Shopper {
  firstName: string
  lastName: string
  email: string
  password: string
}

function newShopper(): Shopper {
  const tag = randomUUID().slice(0, 8)
  return {
    firstName: `Ada${tag}`,
    lastName: 'Signedin',
    email: `account-${tag}@e2e.test`,
    password: 'TestPassword123!',
  }
}

const onAccountHome = (url: URL): boolean => url.pathname.replace(/\/$/, '') === '/account'
const onLogin = (url: URL): boolean => url.pathname.replace(/\/$/, '') === '/account/login'

/** Registers through the storefront's own form, so the token is wherever that template keeps it. */
async function register(page: Page, shopper: Shopper): Promise<void> {
  await page.goto('/account/register')
  const form = page.getByTestId('register-form')
  // Both register forms label their name fields alike; neither shares a test id for them today.
  await form.getByLabel('First Name', { exact: true }).fill(shopper.firstName)
  await form.getByLabel('Last Name', { exact: true }).fill(shopper.lastName)
  await form.getByTestId('register-email').fill(shopper.email)
  // Next asks for the password twice, Astro once: every password field gets the same one.
  const passwords = form.locator('input[type="password"]')
  for (let i = 0; i < (await passwords.count()); i += 1)
    await passwords.nth(i).fill(shopper.password)
  await form.locator('button[type="submit"]').click()
  await page.waitForURL(onAccountHome, { timeout: 15_000 })
}

function signOutControl(page: Page) {
  return page
    .getByRole('navigation', { name: 'Account navigation' })
    .getByRole('button', { name: /sign out|log ?out/i })
    .or(
      page
        .getByRole('navigation', { name: 'Account navigation' })
        .getByRole('link', { name: /sign out|log ?out/i }),
    )
}

test.describe('Signed-in account', () => {
  test('AC-5: the dashboard, profile, addresses and orders show the signed-in customer’s own data, and an order opens by its number', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const shopper = newShopper()
    await register(page, shopper)

    // Dashboard: their name and email, not placeholders.
    const dashboard = page.getByTestId('account-dashboard')
    await expect(dashboard).toContainText(shopper.firstName, { timeout: 10_000 })
    await expect(dashboard).toContainText(shopper.email)

    // Profile: the form is filled with their details.
    await page.goto('/account/profile')
    await expect(page.getByTestId('profile-firstName')).toHaveValue(shopper.firstName, {
      timeout: 10_000,
    })

    // Addresses: one added through the form appears in the list, one more than before.
    await page.goto('/account/addresses')
    const list = page.getByTestId('addresses-list')
    await expect(list).toBeVisible({ timeout: 10_000 })
    const cards = list.locator('[data-testid^="address-"]')
    const before = await cards.count()
    const line1 = `${randomUUID().slice(0, 6)} Account Lane`
    const postalCode = `SW${Math.floor(Math.random() * 9) + 1} ${Math.floor(Math.random() * 9) + 1}AA`
    const form = page.getByTestId('add-address-form')
    await form.getByTestId('new-address-firstName').fill(shopper.firstName)
    await form.getByTestId('new-address-lastName').fill(shopper.lastName)
    await form.getByTestId('new-address-addressLine1').fill(line1)
    await form.getByTestId('new-address-city').fill('London')
    await form.getByTestId('new-address-region').fill('Greater London')
    await form.getByTestId('new-address-postalCode').fill(postalCode)
    await form.getByTestId('new-address-country').fill('GB')
    await form.getByTestId('save-address').click()
    await expect(list).toContainText(line1, { timeout: 10_000 })
    await expect(list).toContainText(postalCode)
    await expect(cards).toHaveCount(before + 1)

    // An order placed while signed in (stub payments), for a product of this test's own: the first card on /products
    // is, under the newest default, whatever another journey created last, and that journey asserts its stock.
    const product = await ownProduct(request, await adminToken(request), 5)
    await page.goto(`/product/${product.slug}`)
    const productName = (await page.getByTestId('product-title').innerText()).trim()
    expect(productName.length).toBeGreaterThan(0)
    await page.getByTestId('add-to-cart').click()
    await page.getByTestId('cart-checkout-btn').click()
    // The checkout page's script attaches the forms' submit handlers by `load` (Astro's module script, Next's
    // hydration). A Continue clicked before then submits the contact form natively and reloads the page at the contact
    // step, so the shipping fields never appear: a cold first run in CI does exactly that.
    await page.waitForURL(/\/checkout/, { timeout: 10_000 })
    await page.waitForLoadState('load')
    await page.getByTestId('contact-email').fill(shopper.email)
    await page.getByTestId('contact-continue').click()
    const shipPostal = `E${Math.floor(Math.random() * 9) + 1} ${Math.floor(Math.random() * 9) + 1}BB`
    await page.getByTestId('shipping-firstName').fill(shopper.firstName)
    await page.getByTestId('shipping-lastName').fill(shopper.lastName)
    await page.getByTestId('shipping-addressLine1').fill('9 Checkout Row')
    await page.getByTestId('shipping-city').fill('London')
    await page.getByTestId('shipping-region').fill('Greater London')
    await page.getByTestId('shipping-postalCode').fill(shipPostal)
    await page.getByTestId('shipping-country').fill('GB')
    await page.getByTestId('shipping-continue').click()
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const confirmation = (await page.getByTestId('order-number').innerText()).trim()
    const orderNumber = /(?:NYM|INT)-[A-Za-z0-9-]+/.exec(confirmation)?.[0]
    expect(orderNumber, confirmation).toBeTruthy()

    // Orders: the list shows that order number, and it opens by number to its detail.
    await page.goto('/account/orders')
    await expect(page.getByTestId('orders-list')).toContainText(orderNumber!, { timeout: 10_000 })
    await page.getByTestId(`order-${orderNumber}`).click()
    await page.waitForURL(
      (url) => url.pathname.replace(/\/$/, '') === `/account/orders/${orderNumber}`,
      {
        timeout: 10_000,
      },
    )
    const detail = page.getByTestId('order-detail')
    await expect(detail).toContainText(orderNumber!, { timeout: 10_000 })
    await expect(detail).toContainText(productName)
    await expect(detail).toContainText(shipPostal)
  })

  test('AC-6: Sign Out lands on login, /account then redirects to login, and the browser’s refresh cookie no longer mints a session', async ({
    page,
  }) => {
    const shopper = newShopper()
    await register(page, shopper)
    await expect(signOutControl(page)).toBeVisible({ timeout: 10_000 })

    // The browser holds a working refresh credential before sign-out, so the 401 after it is the revocation.
    const before = await page.request.post(`${API}/api/auth/refresh`, {
      headers: await csrf(page.request, API),
    })
    expect(before.status()).toBe(200)

    await signOutControl(page).click()
    await page.waitForURL(onLogin, { timeout: 10_000 })

    await page.goto('/account')
    await page.waitForURL(onLogin, { timeout: 10_000 })

    const after = await page.request.post(`${API}/api/auth/refresh`, {
      headers: await csrf(page.request, API),
    })
    expect(after.status()).toBe(401)
    expect(after.status()).not.toBe(before.status())
  })

  test('a wrong password shows the API’s refusal in the sign-in form’s alert, and the browser stays signed out', async ({
    page,
  }) => {
    const credentials = { email: `nobody-${randomUUID().slice(0, 8)}@e2e.test`, password: 'wrong' }
    const refusal = await page.request.post(`${API}/api/auth/login`, {
      headers: await csrf(page.request, API),
      data: credentials,
    })
    expect(refusal.status()).toBe(401)
    const { message } = ((await refusal.json()) as { error: { message: string } }).error

    await page.goto('/account/login')
    const form = page.locator('nymbal-login-form')
    await form.getByTestId('login-email').fill(credentials.email)
    await form.getByTestId('login-password').fill(credentials.password)
    await form.getByTestId('login-submit').click()

    await expect(form.getByRole('alert')).toHaveText(message, { timeout: 10_000 })
    const refresh = await page.request.post(`${API}/api/auth/refresh`, {
      headers: await csrf(page.request, API),
    })
    expect(refresh.status(), 'the failed sign-in minted a session').toBe(401)
    await page.goto('/account')
    await page.waitForURL(onLogin, { timeout: 10_000 })
  })

  test('AC-7: a signed-in shopper who reloads /account still sees their dashboard with their email', async ({
    page,
  }) => {
    const shopper = newShopper()
    await register(page, shopper)
    await page.goto('/account')
    await page.reload()
    await expect(page.getByTestId('account-dashboard')).toContainText(shopper.email, {
      timeout: 10_000,
    })
    expect(onAccountHome(new URL(page.url()))).toBe(true)
  })
})

// AC-5: register, sign in, the profile and the add-address form are each an element (`nymbal-register-form`,
// `nymbal-login-form`, `nymbal-profile-form`, `nymbal-address-book`) on both templates. Each control is in its
// element's shadow root, each action reaches the API (read back with a token of the test's own), and sign-in still
// lands on `?redirect`.

/** Whether `[data-testid=testId]` is inside `<host>`'s shadow root (or one nested in it), not in the light DOM. */
function inShadowOf(page: Page, host: string, testId: string): Promise<boolean> {
  return page.evaluate(
    ([tag, id]) => {
      const root = document.querySelector(tag!)?.shadowRoot
      if (!root) return false
      const has = (r: ParentNode): boolean =>
        r.querySelector(`[data-testid="${id}"]`) !== null ||
        [...r.querySelectorAll('*')].some((n) => n.shadowRoot !== null && has(n.shadowRoot))
      return has(root)
    },
    [host, testId],
  )
}

async function apiToken(request: APIRequestContext, shopper: Shopper): Promise<string> {
  const res = await request.post(`${API}/api/auth/login`, {
    headers: await csrf(request, API),
    data: { email: shopper.email, password: shopper.password },
  })
  expect(res.ok(), `POST /api/auth/login: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: { accessToken: string } }).data.accessToken
}

interface Me {
  data: { email: string; firstName: string; lastName: string }
}

test.describe('Account views are elements', () => {
  test('AC-5: theming.views-are-elements: register, sign in, profile and add-address each go through their element, GET /api/customers/me and /addresses show each change, and sign-in lands on ?redirect', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const shopper = newShopper()

    // Register through nymbal-register-form.
    await page.goto('/account/register')
    await expect.poll(() => inShadowOf(page, 'nymbal-register-form', 'register-submit')).toBe(true)
    const register = page.locator('nymbal-register-form')
    await register.getByTestId('register-firstName').fill(shopper.firstName)
    await register.getByTestId('register-lastName').fill(shopper.lastName)
    await register.getByTestId('register-email').fill(shopper.email)
    await register.getByTestId('register-password').fill(shopper.password)
    await register.getByTestId('register-confirmPassword').fill(shopper.password)
    await register.getByTestId('register-submit').click()
    await page.waitForURL(onAccountHome, { timeout: 15_000 })

    const token = await apiToken(request, shopper)
    const auth = { headers: { authorization: `Bearer ${token}` } }
    const me = async (): Promise<Me['data']> =>
      ((await (await request.get(`${API}/api/customers/me`, auth)).json()) as Me).data
    const registered = await me()
    expect(registered.email).toBe(shopper.email)
    expect(registered.firstName).toBe(shopper.firstName)

    // Signed out (no refresh cookie, no stored token), sign in through nymbal-login-form from a guarded page's link.
    await page.context().clearCookies()
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    await page.goto('/account/login?redirect=%2Faccount%2Fprofile')
    await expect.poll(() => inShadowOf(page, 'nymbal-login-form', 'login-submit')).toBe(true)
    const login = page.locator('nymbal-login-form')
    await login.getByTestId('login-email').fill(shopper.email)
    await login.getByTestId('login-password').fill(shopper.password)
    await login.getByTestId('login-submit').click()
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account/profile', {
      timeout: 15_000,
    })

    // Edit the profile through nymbal-profile-form.
    const profile = page.locator('nymbal-profile-form')
    await expect(profile.getByTestId('profile-firstName')).toHaveValue(shopper.firstName, {
      timeout: 10_000,
    })
    expect(await inShadowOf(page, 'nymbal-profile-form', 'profile-save')).toBe(true)
    const lastName = `Edited${randomUUID().slice(0, 6)}`
    expect(lastName).not.toBe(registered.lastName)
    await profile.getByTestId('profile-lastName').fill(lastName)
    await profile.getByTestId('profile-save').click()
    await expect.poll(async () => (await me()).lastName, { timeout: 10_000 }).toBe(lastName)
    expect((await me()).firstName).toBe(registered.firstName)

    // Add an address through nymbal-address-book.
    const addresses = async (): Promise<Array<{ addressLine1: string }>> =>
      (
        (await (await request.get(`${API}/api/customers/me/addresses`, auth)).json()) as {
          data: Array<{ addressLine1: string }>
        }
      ).data
    const before = (await addresses()).length
    await page.goto('/account/addresses')
    await expect.poll(() => inShadowOf(page, 'nymbal-address-book', 'save-address')).toBe(true)
    expect(await inShadowOf(page, 'nymbal-address-book', 'addresses-list')).toBe(true)
    const book = page.locator('nymbal-address-book')
    const line1 = `${randomUUID().slice(0, 6)} Element Lane`
    await book.getByTestId('new-address-firstName').fill(shopper.firstName)
    await book.getByTestId('new-address-lastName').fill(lastName)
    await book.getByTestId('new-address-addressLine1').fill(line1)
    await book.getByTestId('new-address-city').fill('London')
    await book.getByTestId('new-address-region').fill('Greater London')
    await book.getByTestId('new-address-postalCode').fill('E1 6AN')
    await book.getByTestId('new-address-country').fill('GB')
    await book.getByTestId('save-address').click()
    await expect.poll(async () => (await addresses()).length, { timeout: 10_000 }).toBe(before + 1)
    expect((await addresses()).map((a) => a.addressLine1)).toContain(line1)
    await expect(book.getByTestId('addresses-list')).toContainText(line1, { timeout: 10_000 })
  })
})
