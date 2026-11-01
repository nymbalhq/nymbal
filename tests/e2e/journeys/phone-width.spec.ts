import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/fixtures'
import { API_URL } from '../support/csrf'
import { adminToken, ownProduct } from '../support/checkout'
import { phoneWidths } from '../support/phone-width'
import { formReady } from '../support/sign-in'

// At a phone's width no storefront page is wider than the viewport: every page a shopper reaches, on both templates,
// measured once its content has rendered. Tagged @phone-width, so only the astro-mobile and nextjs-mobile projects run
// it, at Pixel 7 (tests/e2e/playwright.config.ts).

/** Holds the page the browser is on to the phone's width; soft, so one run measures every page. */
async function expectPhoneWidth(page: Page, name: string): Promise<void> {
  const { scrollWidth, innerWidth, viewport, measured } = await phoneWidths(page, name)
  expect.soft(scrollWidth, measured).toBeLessThanOrEqual(viewport + 1)
  expect.soft(innerWidth, measured).toBe(viewport)
}

/** Opens `path`, waits for what shows the page has rendered, and measures it. */
async function measure(
  page: Page,
  name: string,
  path: string,
  ready: () => Promise<void>,
): Promise<void> {
  await page.goto(path)
  await ready()
  await expectPhoneWidth(page, name)
}

test.describe('Storefront at a phone’s width @phone-width', () => {
  test('home, the listings, a product, search with and without hits, the empty cart, sign-in, register, both alert pages before and after the press, and a missing page are each no wider than the viewport', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const product = await ownProduct(request, await adminToken(request), 5)
    const categories = (
      (await (await request.get(`${API_URL}/api/categories`)).json()) as {
        data: Array<{ slug: string }>
      }
    ).data
    expect(categories.length, 'the store has categories').toBeGreaterThan(0)
    // The product's name ends in a tag no other product has: a term with exactly one hit.
    const term = product.name.split(' ').at(-1)!
    const cards = page.locator('[data-testid^="product-card-"]')

    await measure(page, 'home', '/', () => expect(page.getByTestId('hero-section')).toBeVisible())
    await measure(page, 'products', '/products', () => expect(cards.first()).toBeVisible())
    await measure(page, 'category', `/category/${categories[0]!.slug}`, () =>
      expect(page.getByTestId('sort-dropdown')).toBeVisible(),
    )
    await measure(page, 'product', `/product/${product.slug}`, () =>
      expect(page.getByTestId('add-to-cart')).toBeVisible(),
    )
    await measure(page, 'search-hit', `/search?q=${encodeURIComponent(term)}`, () =>
      expect(page.getByTestId(`product-card-${product.slug}`)).toBeVisible(),
    )
    await measure(page, 'search-miss', `/search?q=nohit${randomUUID().slice(0, 8)}`, () =>
      expect(page.getByRole('heading', { name: 'No results found' })).toBeVisible(),
    )
    await measure(page, 'cart-empty', '/cart', () =>
      expect(page.getByTestId('continue-shopping')).toBeVisible(),
    )
    await measure(page, 'login', '/account/login', () => formReady(page, 'nymbal-login-form'))
    await measure(page, 'register', '/account/register', () =>
      formReady(page, 'nymbal-register-form'),
    )
    // A token the store never issued: each page shows its button, and the press shows that the link is not valid.
    for (const [name, path] of [
      ['alert-confirm', '/alerts/confirm'],
      ['alert-unsubscribe', '/alerts/unsubscribe'],
    ] as const) {
      const button = page.getByTestId(`${name}-submit`)
      await measure(page, name, `${path}?token=never-issued-${randomUUID()}`, () =>
        expect(button).toBeVisible(),
      )
      await button.click()
      await expect(page.getByTestId('alert-link-invalid')).toBeVisible()
      await expectPhoneWidth(page, `${name} pressed`)
    }
    await measure(page, 'not-found', `/no-such-page-${randomUUID()}`, () =>
      expect(page.locator('body')).toContainText(/404|not found/i),
    )
  })

  test('the cart drawer, the cart with a line, each checkout step and the order page are each no wider than the viewport', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const product = await ownProduct(request, await adminToken(request), 5)

    await page.goto(`/product/${product.slug}`)
    await page.getByTestId('add-to-cart').click({ timeout: 15_000 })
    const drawer = page.getByTestId('cart-drawer')
    await expect(drawer).toBeInViewport({ timeout: 10_000 })
    await expect(drawer.getByTestId(`cart-item-${product.variantId}`)).toBeVisible()
    await expectPhoneWidth(page, 'drawer')

    await measure(page, 'cart-item', '/cart', () =>
      expect(page.locator('main').getByTestId(`cart-item-${product.variantId}`)).toBeVisible(),
    )
    // The checkout's script attaches the forms' handlers by `load`; a Continue pressed before submits natively.
    await measure(page, 'checkout-contact', '/checkout', async () => {
      await page.waitForLoadState('load')
      await expect(page.getByTestId('contact-email')).toBeVisible()
    })
    await page.getByTestId('contact-email').fill(`phonewidth-${randomUUID().slice(0, 8)}@e2e.test`)
    await page.getByTestId('contact-continue').click()
    await expect(page.getByTestId('shipping-firstName')).toBeVisible()
    await expectPhoneWidth(page, 'checkout-shipping')

    for (const [field, value] of Object.entries({
      firstName: 'Journey',
      lastName: 'Shopper',
      addressLine1: '12 Checkout Row',
      city: 'Leeds',
      region: 'West Yorkshire',
      postalCode: 'LS1 4AP',
      country: 'GB',
    })) {
      await page.getByTestId(`shipping-${field}`).fill(value)
    }
    await page.getByTestId('shipping-continue').click()
    await expect(page.getByTestId('place-order')).toBeEnabled({ timeout: 10_000 })
    await expectPhoneWidth(page, 'checkout-payment')

    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    await expect(page.getByTestId('order-heading')).toBeVisible({ timeout: 15_000 })
    await expectPhoneWidth(page, 'order')
  })
})
