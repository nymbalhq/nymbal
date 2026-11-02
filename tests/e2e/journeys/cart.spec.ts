import type { BrowserContext, Page } from '@playwright/test'
import { adminToken, ownProduct } from '../support/checkout'
import { API_URL } from '../support/csrf'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { noScript } from '../support/server-rendered'

interface ApiCart {
  data: { items: Array<{ variantId: string; productName: string; qty: number }> }
}

function quantitySum(cart: ApiCart): number {
  return cart.data.items.reduce((sum, item) => sum + item.qty, 0)
}

test.describe('Cart interactions', () => {
  test.beforeEach(async ({ page }) => {
    // A fixed seeded product: the first card on /products is, under the newest default, whatever another journey
    // created last, and that journey may assert its stock.
    await page.goto('/product/ceramic-mug')
    await page.waitForSelector('[data-testid="add-to-cart"]')
  })

  test('AC-4: adding a product opens the cart drawer on the lines GET /api/cart holds, by name and quantity', async ({
    page,
  }) => {
    await page.getByTestId('add-to-cart').click()
    const drawer = page.getByTestId('cart-drawer')
    await expect(drawer).toBeInViewport({ timeout: 10000 })
    const lines = drawer.locator('[data-testid^="cart-item-"]')
    await expect(lines.first()).toBeVisible({ timeout: 10000 })

    const res = await page.request.get(`${API_URL}/api/cart`)
    expect(res.status()).toBe(200)
    const cart = (await res.json()) as ApiCart
    expect(quantitySum(cart), 'one click adds one unit').toBe(1)
    await expect(lines).toHaveCount(cart.data.items.length)
    for (const item of cart.data.items) {
      const line = drawer.getByTestId(`cart-item-${item.variantId}`)
      await expect(line).toContainText(item.productName)
      await expect(line).toContainText(`Qty: ${item.qty}`)
    }
  })

  test('AC-4: /cart shows the empty state while GET /api/cart is empty, and the lines it holds once it is not', async ({
    page,
  }) => {
    await page.goto('/cart')
    const empty = (await (await page.request.get(`${API_URL}/api/cart`)).json()) as ApiCart
    expect(empty.data.items).toHaveLength(0)
    await expect(page.getByTestId('continue-shopping')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid^="cart-item-"]')).toHaveCount(empty.data.items.length)

    await page.goto('/product/ceramic-mug')
    await page.getByTestId('add-to-cart').click()
    await expect(
      page.getByTestId('cart-drawer').locator('[data-testid^="cart-item-"]').first(),
    ).toBeVisible({ timeout: 10000 })
    await page.goto('/cart')
    const full = (await (await page.request.get(`${API_URL}/api/cart`)).json()) as ApiCart
    expect(full.data.items.length).toBeGreaterThan(0)
    await expect(page.locator('main').locator('[data-testid^="cart-item-"]')).toHaveCount(
      full.data.items.length,
      { timeout: 10000 },
    )
    for (const item of full.data.items) {
      await expect(page.locator('main').getByTestId(`cart-item-${item.variantId}`)).toContainText(
        item.productName,
        { timeout: 10000 },
      )
    }
    await expect(page.getByTestId('continue-shopping')).toHaveCount(0)
  })

  test('AC-4: closing the drawer leaves the mini-cart badge at the quantity sum GET /api/cart holds', async ({
    page,
  }) => {
    const drawer = page.getByTestId('cart-drawer')
    // Two adds of one product, closing the drawer after each: the line's quantity, not the line count, is the sum.
    for (let added = 1; added <= 2; added++) {
      await page.getByTestId('add-to-cart').click()
      await expect(drawer.locator('[data-testid^="cart-item-"]').first()).toContainText(
        `Qty: ${added}`,
        { timeout: 10000 },
      )
      await page.getByTestId('cart-drawer-close').click()
      await expect(drawer).not.toBeInViewport()
    }

    const cart = (await (await page.request.get(`${API_URL}/api/cart`)).json()) as ApiCart
    expect(quantitySum(cart)).toBe(2)
    await expect(page.getByTestId('mini-cart-badge')).toHaveText(String(quantitySum(cart)))
  })
})

// AC-5: the cart page is `nymbal-cart-page` on both templates. Its lines are in the element's shadow root, not the
// template's markup, and agree with GET /api/cart: one line per item in its order, each with its product name, and the
// summary showing the API's subtotalMinor.

interface ApiCartLines {
  data: {
    items: Array<{ variantId: string; productName: string; qty: number }>
    subtotalMinor: number
    currency: string
  }
}

/** The cart lines `nymbal-cart-page` renders in its shadow root: test id and text, in document order. */
function cartPageLines(page: Page): Promise<Array<{ id: string; text: string }> | null> {
  return page.evaluate(() => {
    const root = document.querySelector('nymbal-cart-page')?.shadowRoot
    if (!root) return null
    return [...root.querySelectorAll('[data-testid^="cart-item-"]')].map((line) => ({
      id: line.getAttribute('data-testid') ?? '',
      text: line.textContent ?? '',
    }))
  })
}

test.describe('Cart page element', () => {
  test('AC-5: theming.views-are-elements: /cart with two lines added from PDPs renders them inside nymbal-cart-page’s shadow root as GET /api/cart holds them, with its subtotalMinor as the subtotal', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000)
    const token = await adminToken(request)
    // Products of this test's own, so no other journey moves their stock or their lines.
    const products = [await ownProduct(request, token, 5), await ownProduct(request, token, 5)]
    for (const product of products) {
      await page.goto(`/product/${product.slug}`)
      await page.getByTestId('add-to-cart').click()
      await expect(
        page.getByTestId('cart-drawer').getByTestId(`cart-item-${product.variantId}`),
      ).toBeVisible({ timeout: 10_000 })
    }

    await page.goto('/cart')
    const cart = (await (await page.request.get(`${API_URL}/api/cart`)).json()) as ApiCartLines
    expect(cart.data.items.map((i) => i.variantId).sort()).toEqual(
      products.map((p) => p.variantId).sort(),
    )
    await expect
      .poll(async () => (await cartPageLines(page))?.map((line) => line.id), { timeout: 15_000 })
      .toEqual(cart.data.items.map((i) => `cart-item-${i.variantId}`))
    const lines = (await cartPageLines(page))!
    for (const [i, item] of cart.data.items.entries()) {
      expect(lines[i]!.text, `line ${i}`).toContain(item.productName)
    }

    const subtotal = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: cart.data.currency,
    }).format(cart.data.subtotalMinor / 100)
    const summary = await page.evaluate(
      () =>
        document
          .querySelector('nymbal-cart-page')
          ?.shadowRoot?.querySelector('[data-testid="cart-summary"]')?.textContent ?? null,
    )
    expect(summary, 'cart-summary inside nymbal-cart-page').not.toBeNull()
    expect(summary).toContain(subtotal)
  })
})

const CART_COOKIE = 'nymbal.cart'

async function holdsCartCookie(context: BrowserContext): Promise<boolean> {
  return (await context.cookies()).some((cookie) => cookie.name === CART_COOKIE)
}

/**
 * What a shopper with an empty cart sees on /cart: "Your cart is empty" in the cart page (the closed cart drawer, off
 * screen, says it too), one visible Continue Shopping going to /products, and no "Loading your cart..." left on the
 * page.
 */
async function expectEmptyCartShown(page: Page, how: string): Promise<void> {
  await expect(
    page.locator('nymbal-cart-page').getByText('Your cart is empty').filter({ visible: true }),
    how,
  ).toHaveCount(1, {
    timeout: 10_000,
  })
  await expect(
    page.getByTestId('continue-shopping').filter({ visible: true }),
    `${how}: Continue Shopping`,
  ).toHaveAttribute('href', '/products')
  await expect(page.getByText('Loading your cart'), `${how}: the loading shell`).toBeHidden()
}

test.describe('Cart page without a cart cookie', () => {
  test('AC-6: a browser with no nymbal.cart cookie sees the empty cart on /cart with JavaScript off, and with it on once its own cart read answers, and GET /api/cart from that browser has no lines', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(60_000)
    const off = await noScript(browser, testInfo)
    try {
      expect(await holdsCartCookie(off), 'the JS-off context starts with no cart cookie').toBe(
        false,
      )
      const page = await off.newPage()
      await blockExternalRequests(page)
      const res = await page.goto('/cart')
      expect(res?.status(), 'GET /cart').toBe(200)
      await expectEmptyCartShown(page, 'JavaScript off')
    } finally {
      await off.close()
    }

    const baseURL = testInfo.project.use.baseURL
    const on = await browser.newContext(baseURL === undefined ? {} : { baseURL })
    try {
      expect(await holdsCartCookie(on), 'the JS-on context starts with no cart cookie').toBe(false)
      const page = await on.newPage()
      await blockExternalRequests(page)
      const read = page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(API_URL) &&
          new URL(r.url()).pathname === '/api/cart',
        { timeout: 15_000 },
      )
      await page.goto('/cart')
      expect((await read).status(), "the browser's own GET /api/cart").toBe(200)
      await expectEmptyCartShown(page, 'JavaScript on')

      const res = await on.request.get(`${API_URL}/api/cart`)
      expect(res.status(), 'GET /api/cart from the same browser').toBe(200)
      const cart = ((await res.json()) as ApiCartLines).data
      await expect(
        page.locator('[data-testid^="cart-item-"]'),
        'the page shows the lines GET /api/cart holds',
      ).toHaveCount(cart.items.length)
      expect(cart.items, 'lines in the cart the page showed as empty').toEqual([])
    } finally {
      await on.close()
    }
  })
})
