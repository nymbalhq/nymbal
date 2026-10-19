import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

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

  test('cart round-trip: add item increments count, remove item returns count to zero', async ({
    page,
  }) => {
    // Initial mini-cart badge count
    const badge = page.locator('[data-testid="mini-cart-badge"]')
    const initialText = await badge.textContent().catch(() => '')
    const initialCount = parseInt(initialText ?? '0', 10) || 0

    // Add item to cart
    await page.locator('[data-testid="add-to-cart"]').click()
    const drawer = page.locator('[data-testid="cart-drawer"]')
    await expect(drawer).toBeVisible({ timeout: 10000 })

    // Cart drawer should show the added item
    const cartItem = drawer.locator('[data-testid^="cart-item-"]').first()
    await expect(cartItem).toBeVisible({ timeout: 10000 })

    // Mini-cart badge should reflect 1 item added
    await expect(badge).toHaveText(String(initialCount + 1))

    // Remove the item using the correct remove-item-* testid rendered by cart-drawer.ts
    const variantId = await cartItem
      .getAttribute('data-testid')
      .then((id) => id?.replace('cart-item-', ''))
    const removeBtn = cartItem.locator(`[data-testid="remove-item-${variantId}"]`)
    await expect(removeBtn).toBeVisible({ timeout: 5000 })
    await removeBtn.click()

    // Cart should be empty again: the item leaves the drawer and the badge returns to its initial count
    // (the badge is empty at zero).
    await expect(drawer.locator(`[data-testid="cart-item-${variantId}"]`)).toHaveCount(0)
    await expect(badge).toHaveText(initialCount > 0 ? String(initialCount) : '')
  })
})
