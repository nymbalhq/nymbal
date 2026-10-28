import { randomUUID } from 'node:crypto'
import { API_URL } from '../support/csrf'
import {
  adminToken,
  openCheckout,
  ORDER_KEY_HEADER,
  orderKeyOf,
  orderNumberOf,
  ordersFor,
  ownProduct,
  saidConfirmed,
  servedStock,
  walkToPayment,
  watchConfirmedClaim,
} from '../support/checkout'
import { expect, test } from '../support/fixtures'

// AC-7, AC-8 and AC-9 on both templates (the astro and nextjs projects run this file), against the stub store the
// suite starts: the order is confirmed, the cart is empty, and one cart makes one order. Each test buys its own
// product, so its stock moves only by what the test does. The order is read back through the API, never confirmed by
// the test.

interface PlacedOrder {
  status: string
  subtotalMinor: number
  lineItems: Array<{ variantId: string; qty: number; lineSubtotalMinor: number }>
}

const email = (tag: string, trigger = '') =>
  `e2e-checkout-${tag}-${randomUUID().slice(0, 8)}${trigger}@e2e.test`

test.describe('A checkout that completes', () => {
  // Kills: a confirmation page that says confirmed for a pending order, an order holding other lines than the cart's
  // or a subtotal that is not the sum of its lines, a cart left full after payment, and stock moved twice or not at all.
  test('AC-7: a guest checkout ends on /order/<n> headed "Order confirmed" with status confirmed; the API says confirmed, holds the one unit bought at a subtotal equal to its lines, the cart is empty and the stock fell by that unit', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const before = await servedStock(request, product)

    await openCheckout(page, product)
    await walkToPayment(page, email('ac7'))
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const orderNumber = orderNumberOf(page)

    const res = await page.request.get(`${API_URL}/api/orders/${orderNumber}`, {
      headers: { [ORDER_KEY_HEADER]: orderKeyOf(page) },
    })
    expect(res.status(), `GET /api/orders/${orderNumber}: ${await res.text()}`).toBe(200)
    const order = ((await res.json()) as { data: PlacedOrder }).data
    expect(order.status).toBe('confirmed')
    // The order holds the one unit bought, and its subtotal is the sum of its lines.
    expect(order.lineItems.map((line) => [line.variantId, line.qty])).toEqual([
      [product.variantId, 1],
    ])
    expect(order.subtotalMinor).toBe(
      order.lineItems.reduce((sum, line) => sum + line.lineSubtotalMinor, 0),
    )
    const cart = await page.request.get(`${API_URL}/api/cart`)
    expect(((await cart.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(0)
    await expect.poll(() => servedStock(request, product), { timeout: 10_000 }).toBe(before - 1)
    await expect(page.getByTestId('order-heading')).toHaveText(/order confirmed/i, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('order-status')).toHaveText(/confirmed/i)

    // The page's own cart, with no reload: the mini-cart badge renders nothing at zero, and the drawer lists no item.
    await expect(page.getByTestId('mini-cart-badge')).toHaveText('', { timeout: 10_000 })
    await page.getByTestId('mini-cart').click()
    const drawer = page.getByTestId('cart-drawer')
    await expect(drawer).toBeVisible({ timeout: 10_000 })
    await expect(drawer.locator('[data-testid^="cart-item-"]')).toHaveCount(0)
  })

  // Kills: a second order (and a second decrement) from a double click on Place Order.
  test('AC-8: double-clicking Place Order leaves exactly one order for the email and the stock moved once', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const before = await servedStock(request, product)
    const buyer = email('ac8-dbl')

    await openCheckout(page, product)
    await walkToPayment(page, buyer)
    await page.getByTestId('place-order').dblclick()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })

    await expect.poll(() => servedStock(request, product), { timeout: 10_000 }).toBe(before - 1)
    const orders = await ordersFor(request, token, buyer)
    expect(orders.map((o) => o.orderNumber)).toEqual([orderNumberOf(page)])
  })

  // Kills: a resubmit after Back that makes a second order from the same cart instead of landing on the first.
  test('AC-8: Back from the order page and Place Order again lands on the same order; one order for the email and the stock moved once', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const before = await servedStock(request, product)
    const buyer = email('ac8-back')

    await openCheckout(page, product)
    await walkToPayment(page, buyer)
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const first = orderNumberOf(page)

    await page.goBack({ waitUntil: 'load' })
    await page.waitForURL(/\/checkout/, { timeout: 10_000 })
    // AC-8 has the shopper press Place Order again, so Back must leave them on a checkout they can walk.
    await expect(page.getByTestId('contact-email'), 'Back lands on the checkout form').toBeVisible({
      timeout: 15_000,
    })
    await walkToPayment(page, buyer)
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })

    expect(orderNumberOf(page)).toBe(first)
    const orders = await ordersFor(request, token, buyer)
    expect(orders.map((o) => o.orderNumber)).toEqual([first])
    await expect.poll(() => servedStock(request, product), { timeout: 10_000 }).toBe(before - 1)
  })

  // Kills: an order page that announces "Order confirmed" for an order whose payment has not arrived.
  test('AC-9: a +stub-pending checkout shows "Awaiting payment" and never "Order confirmed"; the API says pending', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    await watchConfirmedClaim(page)

    await openCheckout(page, product)
    await walkToPayment(page, email('ac9', '+stub-pending'))
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const orderNumber = orderNumberOf(page)

    await expect(page.getByTestId('order-number')).toHaveText(orderNumber, { timeout: 15_000 })
    const order = await page.request.get(`${API_URL}/api/orders/${orderNumber}`, {
      headers: { [ORDER_KEY_HEADER]: orderKeyOf(page) },
    })
    const status = ((await order.json()) as { data: { status: string } }).data.status
    expect(status).toBe('pending')
    expect(await saidConfirmed(page), 'the page said "Order confirmed" for a pending order').toBe(
      false,
    )
    await expect(page.getByTestId('order-heading')).toHaveText(/awaiting payment/i, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('order-status')).not.toHaveText(/confirmed/i)
    expect(await saidConfirmed(page)).toBe(false)
  })
})
