import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/fixtures'
import { adminToken, ownProduct } from '../support/checkout'
import { csrf } from '../support/csrf'

// P1-09 acceptance (AC-5, AC-6, AC-7): a shopper who signs in sees their own account on either storefront, and
// signing out really signs them out. Both template projects run this file. Selectors are the data-testid contract both
// templates share (templates/CLAUDE.md); the account navigation is found by its aria-label, which both already carry.

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
    email: `p1-09-${tag}@e2e.test`,
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
