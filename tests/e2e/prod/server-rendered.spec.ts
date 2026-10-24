import type { BrowserContext, Page } from '@playwright/test'
import { adminToken } from '../support/checkout'
import { API_URL } from '../support/csrf'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { addOneLine, noScript, type ApiCart } from '../support/server-rendered'
import { formatPrice, optionProduct, type OptionCombination } from '../support/variants'

// AC-4, on production builds of both templates (playwright.prod.config.ts), with JavaScript off: the pages arrive with
// their Nymbal elements rendered. With a `nymbal.cart` cookie holding one line (added on the PDP with JS on, so the
// API's Set-Cookie is the jar's), `/cart` lists the line inside `nymbal-cart-page`'s shadow root, `/checkout` shows the
// contact step and the line in its summary, and the header's `nymbal-mini-cart` shows the line count;
// `/search?q=wool` lists the API's wool cards inside `nymbal-search-results`; a product page shows the variant
// selector's options, the quantity selector and add-to-cart; the account login and register pages show their forms.
// Every assertion reads the parsed DOM (Chrome parses the declarative shadow roots), except the token's: the cart
// token and `customerId` are in the HTML source of none of `/cart`, `/checkout` and `/`.

/** Two options of two values; the product page offers each value once. */
const COMBINATIONS: OptionCombination[] = [
  {
    options: [
      { name: 'Colour', value: 'Red' },
      { name: 'Size', value: 'S' },
    ],
    priceMinor: 1500,
    stock: 2,
  },
  {
    options: [
      { name: 'Colour', value: 'Red' },
      { name: 'Size', value: 'M' },
    ],
    priceMinor: 1600,
    stock: 3,
  },
  {
    options: [
      { name: 'Colour', value: 'Blue' },
      { name: 'Size', value: 'S' },
    ],
    priceMinor: 1700,
    stock: 0,
  },
  {
    options: [
      { name: 'Colour', value: 'Blue' },
      { name: 'Size', value: 'M' },
    ],
    priceMinor: 1800,
    stock: 4,
  },
]

interface Shopper {
  on: BrowserContext
  off: BrowserContext
  cart: ApiCart
}

const shoppers: BrowserContext[] = []

/** A shopper with one line in the cart, and a JS-off context holding the same cookie. */
async function shopper(
  browser: Parameters<typeof noScript>[0],
  testInfo: Parameters<typeof noScript>[1],
): Promise<Shopper> {
  const baseURL = testInfo.project.use.baseURL
  const on = await browser.newContext(baseURL === undefined ? {} : { baseURL })
  const cart = await addOneLine(on)
  const off = await noScript(browser, testInfo, on)
  shoppers.push(on, off)
  return { on, off, cart }
}

async function open(context: BrowserContext, path: string): Promise<{ page: Page; html: string }> {
  const page = await context.newPage()
  await blockExternalRequests(page)
  const response = await page.goto(path)
  expect(response?.status(), `GET ${path}`).toBe(200)
  return { page, html: (await response!.text()) ?? '' }
}

test.afterEach(async () => {
  for (const context of shoppers.splice(0)) await context.close()
})

test.describe('AC-4: the pages are rendered with JavaScript off', () => {
  test('AC-4: theming.server-rendered: /cart lists the line’s name, quantity and price and the subtotal inside nymbal-cart-page’s shadow root', async ({
    browser,
  }, testInfo) => {
    const { off, cart } = await shopper(browser, testInfo)
    const line = cart.items[0]!
    const { page } = await open(off, '/cart')
    const host = page.locator('nymbal-cart-page')

    await expect(host.locator('[part~="item-name"]')).toHaveText([line.productName])
    await expect(host.locator('nymbal-quantity-selector')).toHaveAttribute(
      'value',
      String(line.qty),
    )
    await expect(host.locator('[part~="item-price"]')).toContainText(
      formatPrice(line.priceMinor, cart.currency),
    )
    await expect(host.locator('[part~="item-total"]')).toHaveText(
      formatPrice(line.priceMinor * line.qty, cart.currency),
    )
    await expect(host.locator('[part~="subtotal"]')).toContainText(
      formatPrice(cart.subtotalMinor, cart.currency),
    )
  })

  test('AC-4: theming.server-rendered: /checkout shows the contact step and the order summary with the same line', async ({
    browser,
  }, testInfo) => {
    const { off, cart } = await shopper(browser, testInfo)
    const line = cart.items[0]!
    const { page } = await open(off, '/checkout')
    const host = page.locator('nymbal-checkout')

    await expect(host.getByTestId('checkout-contact')).toBeVisible()
    await expect(host.getByTestId('checkout-shipping')).toBeHidden()
    await expect(host.getByTestId('checkout-payment')).toBeHidden()
    const summary = host.getByTestId('checkout-summary')
    await expect(summary.locator('[part~="item-name"]')).toHaveText([line.productName])
    await expect(summary.locator('[part~="item-price"]')).toHaveText([
      formatPrice(line.priceMinor * line.qty, cart.currency),
    ])
    await expect(host.getByTestId('cart-subtotal')).toHaveText(
      formatPrice(cart.subtotalMinor, cart.currency),
    )
  })

  // The header is nymbal-site-header with the mini-cart as its light-DOM child. Next's / is cached for every shopper,
  // so its header carries no count; the count with JS off is on Next's /cart and /checkout
  // (tests/e2e/prod/next-isr.spec.ts AC-5), and Next's / gets the no-count check (AC-4). Astro renders every page per
  // request and keeps the count on /.
  test('AC-4: theming.server-rendered: the header’s nymbal-mini-cart shows the cart’s item count on / (Astro) @astro', async ({
    browser,
  }, testInfo) => {
    const { off, cart } = await shopper(browser, testInfo)
    const count = cart.items.reduce((n, l) => n + l.qty, 0)
    const { page } = await open(off, '/')

    const badges = page
      .locator('nymbal-site-header nymbal-mini-cart')
      .getByTestId('mini-cart-badge')
    const texts = (await badges.allTextContents()).map((t) => t.trim())
    expect(texts.length, 'header mini-cart badges').toBeGreaterThan(0)
    expect(texts).toEqual(texts.map(() => String(count)))
  })

  test('AC-4: theming.server-rendered: the cart token and customerId are in the HTML of none of /cart, /checkout and /', async ({
    browser,
  }, testInfo) => {
    const { off, cart } = await shopper(browser, testInfo)
    expect(cart.token.length, 'GET /api/cart serves the token').toBeGreaterThan(0)
    const line = cart.items[0]!

    for (const path of ['/cart', '/checkout', '/']) {
      const { html } = await open(off, path)
      expect(html.includes(cart.token), `${path} carries the cart token`).toBe(false)
      expect(html.includes('customerId'), `${path} carries customerId`).toBe(false)
      // Not vacuous: the cart and checkout pages carry the cart the token names.
      if (path !== '/') {
        expect(html.split(line.productName).length - 1, `${path} renders the line`).toBeGreaterThan(
          0,
        )
      }
    }
  })

  test('AC-4: theming.server-rendered: /search?q=wool lists the API’s wool cards, nymbal-product-cards inside nymbal-search-results', async ({
    browser,
  }, testInfo) => {
    const off = await noScript(browser, testInfo)
    shoppers.push(off)
    const res = await off.request.get(`${API_URL}/api/products/search?q=wool`)
    expect(res.status()).toBe(200)
    const found = ((await res.json()) as { data: { items: Array<{ slug: string }> } }).data.items
    expect(found.length, 'seeded products matching "wool"').toBeGreaterThan(0)

    const { page } = await open(off, '/search?q=wool')
    const cards = page
      .locator('nymbal-search-results')
      .locator('nymbal-product-card')
      .locator('[data-testid^="product-card-"]')
    await expect(cards).toHaveCount(found.length)
    const slugs: string[] = []
    for (let i = 0; i < found.length; i += 1) {
      slugs.push(
        ((await cards.nth(i).getAttribute('data-testid')) ?? '').slice('product-card-'.length),
      )
    }
    expect(slugs).toEqual(found.map((p) => p.slug))
  })

  test('AC-4: theming.server-rendered: a product page shows the variant selector’s options, the quantity selector and the add-to-cart button', async ({
    browser,
    request,
  }, testInfo) => {
    const product = await optionProduct(request, await adminToken(request), COMBINATIONS)
    const offered = [
      ...new Set(
        product.variants.flatMap((v) => v.options.map((o) => `${o.name}\u0000${o.value}`)),
      ),
    ]
      .map((pair) => pair.split('\u0000')[1]!)
      .sort()
    const off = await noScript(browser, testInfo)
    shoppers.push(off)
    const { page } = await open(off, `/product/${product.slug}`)
    const main = page.locator('main')

    const options = main.locator('nymbal-variant-selector').locator('[part~="option"]')
    expect((await options.allTextContents()).map((t) => t.trim()).sort()).toEqual(offered)
    const quantity = main.locator('nymbal-quantity-selector').first()
    for (const part of ['decrement', 'input', 'increment']) {
      await expect(quantity.locator(`[part~="${part}"]`), `quantity selector ${part}`).toHaveCount(
        1,
      )
    }
    await expect(main.locator('nymbal-add-to-cart').getByTestId('add-to-cart')).toHaveText(
      'Add to Cart',
    )
  })

  for (const [path, tag] of [
    ['/account/login', 'nymbal-login-form'],
    ['/account/register', 'nymbal-register-form'],
  ] as const) {
    test(`AC-4: theming.server-rendered: ${path} shows ${tag}’s form, a label for each field and its submit`, async ({
      browser,
    }, testInfo) => {
      const off = await noScript(browser, testInfo)
      shoppers.push(off)
      const { page } = await open(off, path)
      const form = page.locator(tag)

      await expect(form.locator('[part~="form"]')).toHaveCount(1)
      const inputs = await form.locator('[part~="input"]').count()
      expect(inputs, `${tag} fields`).toBeGreaterThan(0)
      expect(await form.locator('[part~="label"]').count()).toBe(inputs)
      await expect(form.locator('[part~="submit"]')).toBeVisible()
    })
  }
})
