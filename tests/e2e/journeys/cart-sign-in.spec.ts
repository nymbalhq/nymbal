import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { expect, test } from '../support/fixtures'
import { formReady, signIn } from '../support/sign-in'
import { cartLines, cartQty } from '../support/variants'

// On both templates: a guest who signs in keeps their guest lines and gets the lines their account already held, in
// one cart, on /cart and in the mini-cart badge; and a /cart line's name leads to its product page.

const PASSWORD = 'TestPassword123!'

const onAccountHome = (url: URL): boolean => url.pathname.replace(/\/$/, '') === '/account'

/** Sets the PDP's quantity selector to `qty`, adds, and waits for the API cart to hold `qty` more of the variant. */
async function addFromPdp(page: Page, product: OwnProduct, qty: number): Promise<void> {
  await page.goto(`/product/${product.slug}`)
  await page.waitForLoadState('networkidle')
  const pdp = page.locator('main')
  const before = await cartQty(page, product.variantId)
  const input = pdp.getByTestId('qty-input')
  await expect(input).toHaveValue('1', { timeout: 15_000 })
  if (qty !== 1) {
    await input.fill(String(qty))
    await expect(input).toHaveValue(String(qty))
  }
  await pdp.getByTestId('add-to-cart').click()
  await expect
    .poll(() => cartQty(page, product.variantId), { timeout: 10_000 })
    .toBe(before + qty)
}

/** Registers through the storefront's own form, which signs the browser in. */
async function register(page: Page, email: string): Promise<void> {
  await page.goto('/account/register')
  await formReady(page, 'nymbal-register-form')
  const form = page.getByTestId('register-form')
  await form.getByLabel('First Name', { exact: true }).fill('Ada')
  await form.getByLabel('Last Name', { exact: true }).fill('Merge')
  await form.getByTestId('register-email').fill(email)
  // Next asks for the password twice, Astro once: every password field gets the same one.
  const passwords = form.locator('input[type="password"]')
  for (let i = 0; i < (await passwords.count()); i += 1) await passwords.nth(i).fill(PASSWORD)
  await form.locator('button[type="submit"]').click()
  await page.waitForURL(onAccountHome, { timeout: 15_000 })
}

const sumOf = (lines: Array<{ qty: number }>): number => lines.reduce((n, l) => n + l.qty, 0)

test.describe('The cart at sign-in', () => {
  test('AC-12: cart.sign-in-merge: an account holding X × 2 (added in another browser, then registered), a guest adding X × 3 and Y × 1 then signing in: /cart shows X × 5 and Y × 1, and the mini-cart badge equals 6 and the GET /api/cart sum, before and after a reload', async ({
    page,
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const X = await ownProduct(request, token, 50)
    const Y = await ownProduct(request, token, 50)
    const email = `merge-${randomUUID().slice(0, 8)}@e2e.test`
    const account = { X: 2 }
    const guest = { X: 3, Y: 1 }

    // The account's cart, made through the storefront in a browser of its own.
    const other = await browser.newContext({ ...(baseURL !== undefined && { baseURL }) })
    try {
      const elsewhere = await other.newPage()
      await addFromPdp(elsewhere, X, account.X)
      await register(elsewhere, email)
    } finally {
      await other.close()
    }

    await addFromPdp(page, X, guest.X)
    await addFromPdp(page, Y, guest.Y)
    await signIn(page, email, PASSWORD)
    await page.waitForURL(onAccountHome, { timeout: 15_000 })

    const expected = new Map([
      [X.variantId, account.X + guest.X],
      [Y.variantId, guest.Y],
    ])
    await page.goto('/cart')
    for (const reloaded of [false, true]) {
      if (reloaded) await page.reload()
      const label = reloaded ? 'after a reload' : 'before a reload'
      const lines = await cartLines(page)
      expect(
        lines.map((l) => [l.variantId, l.qty]).sort(),
        `${label}: GET /api/cart`,
      ).toEqual([...expected].sort())
      for (const [variantId, qty] of expected) {
        await expect(
          page.locator('main').getByTestId(`cart-item-${variantId}`).getByTestId('qty-input'),
          `${label}: /cart line ${variantId}`,
        ).toHaveValue(String(qty), { timeout: 15_000 })
      }
      expect(sumOf(lines), label).toBe(account.X + guest.X + guest.Y)
      await expect(page.getByTestId('mini-cart-badge'), `${label}: badge`).toHaveText(
        String(sumOf(lines)),
        { timeout: 10_000 },
      )
    }
  })
})

test.describe('The cart line link', () => {
  test('AC-13: cart.line-link: the /cart line name links to /product/<slug>, and following it lands on that product’s page (200, its name in the heading)', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000)
    const product = await ownProduct(request, await adminToken(request), 10)
    await addFromPdp(page, product, 1)
    const href = `/product/${encodeURIComponent(product.slug)}`

    await page.goto('/cart')
    const link = page
      .locator('main')
      .getByTestId(`cart-item-${product.variantId}`)
      .getByRole('link', { name: product.name })
    await expect(link).toHaveAttribute('href', href, { timeout: 15_000 })
    await link.click()

    await page.waitForURL((url) => url.pathname === href, { timeout: 15_000 })
    expect((await page.request.get(page.url())).status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(product.name)
  })
})
