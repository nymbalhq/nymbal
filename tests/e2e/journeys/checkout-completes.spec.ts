import { randomUUID } from 'node:crypto'
import { API_URL } from '../support/csrf'
import {
  adminToken,
  openCheckout,
  orderNumberOf,
  ordersFor,
  ownProduct,
  saidConfirmed,
  servedStock,
  walkToPayment,
  watchConfirmedClaim,
} from '../support/checkout'
import { expect, test } from '../support/fixtures'

// P1-12 AC-7, AC-8 and AC-9 on both templates (the astro and nextjs projects run this file), against the stub store
// the suite starts: store end states checkout.order-confirmed, checkout.cart-empty and checkout.single-order. Each test
// buys its own product, so its stock moves only by what the test does. The order is read back through the API, never
// confirmed by the test.

const email = (tag: string, trigger = '') =>
  `e2e-p1-12-${tag}-${randomUUID().slice(0, 8)}${trigger}@e2e.test`

test.describe('A checkout that completes', () => {
  // Kills: a confirmation page that says confirmed for a pending order, a cart left full after payment, and stock
  // moved twice or not at all.
  test('AC-7: a guest checkout ends on /order/<n> headed "Order confirmed" with status confirmed; the API says confirmed, the cart is empty and the stock fell by the one unit bought', async ({
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

    const order = await page.request.get(`${API_URL}/api/orders/${orderNumber}`)
    expect(((await order.json()) as { data: { status: string } }).data.status).toBe('confirmed')
    const cart = await page.request.get(`${API_URL}/api/cart`)
    expect(((await cart.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(0)
    await expect.poll(() => servedStock(request, product), { timeout: 10_000 }).toBe(before - 1)
    await expect(page.getByTestId('order-heading')).toHaveText(/order confirmed/i, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('order-status')).toHaveText(/confirmed/i)
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
    const order = await page.request.get(`${API_URL}/api/orders/${orderNumber}`)
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
