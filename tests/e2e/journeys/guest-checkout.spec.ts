import { randomUUID } from 'node:crypto'
import { API_URL } from '../support/csrf'
import {
  adminToken,
  openCheckout,
  orderNumberOf,
  ownProduct,
  servedStock,
  walkToPayment,
} from '../support/checkout'
import { expect, test } from '../support/fixtures'

// The guest purchase journey on both templates. It buys a product of its own (`ownProduct`): the first card on
// /products is, under the newest default, whatever another journey created last, and buying that moves a stock
// another journey asserts on (P1-11 review B1). The order is read back through the API.

interface OrderLine {
  variantId: string
  qty: number
  lineSubtotalMinor: number
}

test('guest can complete a purchase end-to-end: the order the API holds is the one unit bought, and its stock fell by one', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const token = await adminToken(request)
  const product = await ownProduct(request, token, 5)
  const before = await servedStock(request, product)

  await openCheckout(page, product)
  await expect(page.getByTestId('checkout-steps')).toBeVisible()
  await walkToPayment(page, `e2e-guest-${randomUUID().slice(0, 8)}@e2e.test`)
  await page.getByTestId('place-order').click()
  await page.waitForURL(/\/order\//, { timeout: 20_000 })
  const orderNumber = orderNumberOf(page)
  expect(orderNumber).toMatch(/^(NYM|INT)-/)
  await expect(page.getByTestId('order-number')).toContainText(orderNumber, { timeout: 10_000 })

  const res = await page.request.get(`${API_URL}/api/orders/${orderNumber}`)
  expect(res.status(), `GET /api/orders/${orderNumber}: ${await res.text()}`).toBe(200)
  const order = ((await res.json()) as { data: { lineItems: OrderLine[]; subtotalMinor: number } })
    .data
  expect(order.lineItems.map((line) => [line.variantId, line.qty])).toEqual([
    [product.variantId, 1],
  ])
  expect(order.subtotalMinor).toBe(
    order.lineItems.reduce((sum, line) => sum + line.lineSubtotalMinor, 0),
  )
  await expect.poll(() => servedStock(request, product), { timeout: 10_000 }).toBe(before - 1)
})
