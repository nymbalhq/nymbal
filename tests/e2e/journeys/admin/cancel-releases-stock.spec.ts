import { request as playwrightRequest } from '@playwright/test'
import { SHIPPING_ADDRESS, signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct, servedStock } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// AC-4 on the admin the API serves: a pending order's stock is held from checkout; the admin's Cancel order gives it
// back at once, as the storefront's product read serves it, not when the reservation's 15 minutes run out.

test.describe('Admin cancel', () => {
  test('AC-4: Cancel order on a pending order shows it Cancelled, and GET /api/products/:slug serves the variant’s stock back at its value before the checkout', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 6)
    const before = await servedStock(request, product)
    const qty = 2

    // A shopper of their own, so the order's cart holds this product only; `+stub-pending` keeps the order unpaid.
    const shopper = await playwrightRequest.newContext()
    let orderNumber: string
    try {
      const added = await shopper.post(`${API_URL}/api/cart/items`, {
        headers: await csrf(shopper),
        data: { variantId: product.variantId, qty },
      })
      expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)
      const checkout = await shopper.post(`${API_URL}/api/checkout`, {
        headers: await csrf(shopper),
        data: {
          email: `e2e-cancel-${Date.now()}+stub-pending@nymbal.dev`,
          billingAddress: SHIPPING_ADDRESS,
          shippingAddress: SHIPPING_ADDRESS,
        },
      })
      expect(checkout.ok(), `POST /api/checkout: ${await checkout.text()}`).toBe(true)
      const placed = (
        (await checkout.json()) as {
          data: { orderNumber: string; orderStatus: string }
        }
      ).data
      expect(placed.orderStatus).toBe('pending')
      orderNumber = placed.orderNumber
    } finally {
      await shopper.dispose()
    }
    await expect
      .poll(() => servedStock(request, product), { timeout: 10_000, message: 'stock held' })
      .toBe(before - qty)

    await signInAsAdmin(page)
    await page.goto(`orders/${orderNumber}`)
    await expect(page.getByTestId('admin-order-detail')).toContainText(orderNumber, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Pending')
    await page.getByTestId('admin-order-actions').click()
    await page.getByRole('menuitem', { name: 'Cancel order' }).click()

    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Cancelled', {
      timeout: 15_000,
    })
    await expect
      .poll(() => servedStock(request, product), {
        timeout: 10_000,
        message: 'stock after Cancel order',
      })
      .toBe(before)
  })
})
