import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import {
  adminToken,
  openCheckout,
  ORDER_KEY_HEADER,
  orderKeyOf,
  orderNumberOf,
  ownProduct,
  walkToPayment,
  type OwnProduct,
} from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// cart.discount-code, checkout.discount-charged, checkout.code-at-payment and the code buttons' submit-once rule, on
// both templates: a shopper types a code on /cart or in the checkout summary, sees the discount and the total the API
// settled, and the order charges what the summary showed. Every amount is read back from the API, never computed here.

interface ApiCart {
  items: Array<{ variantId: string; qty: number }>
  subtotalMinor: number
  totals: { discountTotalMinor: number; totalMinor: number }
  promotions: { codes: Array<{ code: string; status: string; reason?: string }> }
}

interface OrderRead {
  orderNumber: string
  discountTotalMinor: number
  totalMinor: number
}

const gbp = (minor: number): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100)
const squash = (text: string): string => text.replace(/\s+/g, '')
/** The minor units of the one amount a summary text shows (`Total £17.99` → 1799). */
const minorOf = (text: string): number => {
  const match = /£([\d,]+\.\d{2})/.exec(text)
  if (match === null) throw new Error(`no £ amount in ${JSON.stringify(text)}`)
  return Math.round(Number(match[1]!.replace(/,/g, '')) * 100)
}

/** A 10% code made through the admin API, in upper case; the shopper types it in lower case. */
async function tenPercentCode(request: APIRequestContext, token: string): Promise<string> {
  const code = `E2E-TEN-${randomUUID().slice(0, 8)}`.toUpperCase()
  const res = await request.post(`${API_URL}/api/admin/promotions`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: { code, kind: 'percent', percentBps: 1000 },
  })
  expect(res.status(), `POST /api/admin/promotions: ${await res.text()}`).toBe(201)
  return code
}

/** `GET /api/cart` with the browser's cart cookie. */
async function apiCart(page: Page): Promise<ApiCart> {
  const res = await page.request.get(`${API_URL}/api/cart`)
  expect(res.status(), `GET /api/cart: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: ApiCart }).data
}

async function orderRead(page: Page): Promise<OrderRead> {
  const res = await page.request.get(`${API_URL}/api/orders/${orderNumberOf(page)}`, {
    headers: { [ORDER_KEY_HEADER]: orderKeyOf(page) },
  })
  expect(res.status(), `GET /api/orders: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: OrderRead }).data
}

/** Product page, Add to Cart (one unit), then /cart once GET /api/cart holds the line. */
async function openCart(page: Page, product: OwnProduct): Promise<void> {
  await page.goto(`/product/${product.slug}`)
  await expect(page.getByTestId('add-to-cart')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('add-to-cart').click()
  await expect
    .poll(
      async () => (await apiCart(page)).items.find((i) => i.variantId === product.variantId)?.qty,
      {
        timeout: 10_000,
      },
    )
    .toBe(1)
  await page.goto('/cart')
  await page.waitForLoadState('load')
}

async function applyCode(scope: Locator, code: string): Promise<void> {
  await scope.getByTestId('discount-code-input').fill(code, { timeout: 15_000 })
  await scope.getByTestId('discount-code-apply').click()
}

/** The listed code, by its text. */
const listedCode = (scope: Locator, code: string): Locator =>
  scope.locator(`[data-testid="discount-code"][data-code="${code}"]`)

/** The cart page's summary shows the API's discount and total for the cart. */
async function expectCartSummary(page: Page, what: string): Promise<ApiCart> {
  const cart = await apiCart(page)
  const summary = page.locator('nymbal-cart-page')
  await expect
    .poll(async () => squash(await summary.getByTestId('cart-summary-total').innerText()), {
      message: `${what}: cart-summary-total`,
      timeout: 10_000,
    })
    .toContain(gbp(cart.totals.totalMinor))
  if (cart.totals.discountTotalMinor > 0) {
    expect(squash(await summary.getByTestId('cart-summary-discount').innerText()), what).toContain(
      `−${gbp(cart.totals.discountTotalMinor)}`,
    )
  } else {
    await expect(summary.getByTestId('cart-summary-discount'), what).toHaveCount(0)
  }
  return cart
}

test.describe('Discount codes on the cart page and at checkout', () => {
  // Kills: any surface showing a discount the order does not carry, an order charging a total the summary did not
  // show, an unknown code that moves money, or a removed code that still discounts.
  test('AC-19: cart.discount-code, checkout.discount-charged: a 10% code applied on /cart in lower case shows GET /api/cart’s discount and total, after a reload too; an unknown code is listed "This code isn\'t valid." and moves nothing; /checkout shows the same discount before the address and after the quote, the total before the address is the cart’s and the order carries the quote’s; Remove on a second cart takes the discount away', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 10)
    const code = await tenPercentCode(request, token)
    const cartPage = page.locator('nymbal-cart-page')

    await openCart(page, product)
    await applyCode(cartPage, code.toLowerCase())
    await expect(listedCode(cartPage, code.toLowerCase())).toHaveAttribute(
      'data-status',
      'accepted',
      {
        timeout: 10_000,
      },
    )
    const applied = await expectCartSummary(page, 'applied')
    expect(applied.totals.discountTotalMinor).toBe(Math.floor(applied.subtotalMinor / 10))
    expect(applied.totals.discountTotalMinor).toBeGreaterThan(0)

    await page.reload()
    await page.waitForLoadState('load')
    await expect(listedCode(cartPage, code.toLowerCase())).toHaveAttribute(
      'data-status',
      'accepted',
    )
    expect((await expectCartSummary(page, 'after a reload')).totals).toEqual(applied.totals)

    const unknown = `NOPE-${randomUUID().slice(0, 8)}`
    await applyCode(cartPage, unknown)
    await expect(listedCode(cartPage, unknown).getByTestId('discount-code-message')).toHaveText(
      "This code isn't valid.",
      { timeout: 10_000 },
    )
    expect((await expectCartSummary(page, 'with an unknown code')).totals).toEqual(applied.totals)

    await page.getByTestId('checkout-btn').click()
    await page.waitForURL(/\/checkout/, { timeout: 10_000 })
    await page.waitForLoadState('load')
    const checkout = page.locator('nymbal-checkout')
    const discountText = `−${gbp(applied.totals.discountTotalMinor)}`
    await expect
      .poll(
        async () => squash(await checkout.getByTestId('checkout-summary-discount').innerText()),
        {
          timeout: 15_000,
        },
      )
      .toContain(discountText)
    expect(squash(await checkout.getByTestId('checkout-summary-total').innerText())).toContain(
      gbp((await apiCart(page)).totals.totalMinor),
    )

    await walkToPayment(page, `e2e-codes-${randomUUID().slice(0, 8)}@e2e.test`)
    expect(squash(await checkout.getByTestId('checkout-summary-discount').innerText())).toContain(
      discountText,
    )
    const shownTotal = minorOf(await checkout.getByTestId('checkout-summary-total').innerText())
    await checkout.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })

    const order = await orderRead(page)
    expect({ discount: order.discountTotalMinor, total: order.totalMinor }).toEqual({
      discount: applied.totals.discountTotalMinor,
      total: shownTotal,
    })
    await expect(page.getByTestId('order-summary').locator('[part~="discount"] dd')).toHaveText(
      discountText,
      { timeout: 15_000 },
    )

    // A second cart with the code, then Remove.
    await openCart(page, product)
    await applyCode(cartPage, code.toLowerCase())
    await expect(listedCode(cartPage, code.toLowerCase())).toHaveAttribute(
      'data-status',
      'accepted',
      {
        timeout: 10_000,
      },
    )
    await listedCode(cartPage, code.toLowerCase()).getByTestId('discount-code-remove').click()
    await expect(cartPage.getByTestId('discount-code')).toHaveCount(0, { timeout: 10_000 })
    const removed = await expectCartSummary(page, 'removed')
    expect(removed.promotions.codes).toEqual([])
    expect(removed.totals.discountTotalMinor).toBe(0)
    await expect(cartPage.getByTestId('cart-summary-discount')).toHaveCount(0)
  })

  // Kills: a code typed at the payment step (where the agent handoff lands) applied to the cart but not to the quote
  // Place Order sends.
  test('AC-20: checkout.code-at-payment: a code applied in the checkout summary on the payment step re-prices it, a discount shown and a total lower by it, and the order has that discount and total', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 10)
    const code = await tenPercentCode(request, token)
    const checkout = page.locator('nymbal-checkout')

    await openCheckout(page, product)
    await walkToPayment(page, `e2e-pay-code-${randomUUID().slice(0, 8)}@e2e.test`)
    await expect(checkout.getByTestId('checkout-summary-discount')).toHaveCount(0)
    const before = minorOf(await checkout.getByTestId('checkout-summary-total').innerText())

    await applyCode(checkout, code.toLowerCase())
    await expect(listedCode(checkout, code.toLowerCase())).toHaveAttribute(
      'data-status',
      'accepted',
      {
        timeout: 10_000,
      },
    )
    const discount = (await apiCart(page)).totals.discountTotalMinor
    expect(discount).toBeGreaterThan(0)
    await expect
      .poll(
        async () => squash(await checkout.getByTestId('checkout-summary-discount').innerText()),
        {
          timeout: 15_000,
        },
      )
      .toContain(`−${gbp(discount)}`)
    await expect
      .poll(async () => minorOf(await checkout.getByTestId('checkout-summary-total').innerText()), {
        timeout: 15_000,
      })
      .toBe(before - discount)
    await expect(checkout.getByTestId('place-order')).toBeEnabled({ timeout: 15_000 })

    await checkout.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const order = await orderRead(page)
    expect({ discount: order.discountTotalMinor, total: order.totalMinor }).toEqual({
      discount,
      total: before - discount,
    })
  })

  // Kills: Apply or Remove left enabled while its request is in flight, so k clicks make k requests.
  test('AC-21: standing.submit-once: a double-click on Apply sends one POST /api/cart/codes and on Remove one DELETE /api/cart/codes/:code, on /cart and on /checkout', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 10)
    const code = await tenPercentCode(request, token)
    const sent: Array<{ where: string; method: string }> = []
    let where = 'cart'
    page.on('request', (req) => {
      const path = new URL(req.url()).pathname
      if (req.method() === 'POST' && path === '/api/cart/codes')
        sent.push({ where, method: 'POST' })
      if (req.method() === 'DELETE' && path.startsWith('/api/cart/codes/'))
        sent.push({ where, method: 'DELETE' })
    })

    for (const at of ['cart', 'checkout'] as const) {
      where = at
      let scope: Locator
      if (at === 'cart') {
        await openCart(page, product)
        scope = page.locator('nymbal-cart-page')
      } else {
        await openCheckout(page, product)
        scope = page.locator('nymbal-checkout')
      }
      await scope.getByTestId('discount-code-input').fill(code.toLowerCase(), { timeout: 15_000 })
      await scope.getByTestId('discount-code-apply').dblclick()
      await expect(listedCode(scope, code.toLowerCase())).toHaveAttribute(
        'data-status',
        'accepted',
        {
          timeout: 10_000,
        },
      )
      await page.waitForLoadState('networkidle')

      await listedCode(scope, code.toLowerCase()).getByTestId('discount-code-remove').dblclick()
      await expect(scope.getByTestId('discount-code')).toHaveCount(0, { timeout: 10_000 })
      await page.waitForLoadState('networkidle')
      expect((await apiCart(page)).promotions.codes).toEqual([])
    }

    expect(sent).toEqual([
      { where: 'cart', method: 'POST' },
      { where: 'cart', method: 'DELETE' },
      { where: 'checkout', method: 'POST' },
      { where: 'checkout', method: 'DELETE' },
    ])
  })
})
