import { expect, test } from '../support/fixtures'

test.describe('Cart interactions', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to a product page
    await page.goto('/products')
    await page.locator('[data-testid^="product-card-"]').first().click()
    await page.waitForSelector('[data-testid="add-to-cart"]')
  })

  test('add to cart opens cart drawer', async ({ page }) => {
    await page.locator('[data-testid="add-to-cart"]').click()
    await expect(page.locator('[data-testid="cart-drawer"]')).toBeVisible({ timeout: 10000 })
  })

  test('cart page shows empty state initially', async ({ page }) => {
    await page.goto('/cart')
    await expect(page.locator('[data-testid="continue-shopping"]')).toBeVisible({ timeout: 10000 })
  })

  test('cart drawer has close button', async ({ page }) => {
    await page.locator('[data-testid="add-to-cart"]').click()
    await expect(page.locator('[data-testid="cart-drawer"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="cart-drawer-close"]')).toBeVisible()
  })

  test('cart drawer shows added item', async ({ page }) => {
    await page.locator('[data-testid="add-to-cart"]').click()
    const drawer = page.locator('[data-testid="cart-drawer"]')
    await expect(drawer).toBeVisible({ timeout: 10000 })
    // Item should be visible in drawer
    await expect(drawer.locator('[data-testid^="cart-item-"]').first()).toBeVisible({ timeout: 10000 })
  })

  test('cart round-trip: add item increments count, remove item returns count to zero', async ({ page }) => {
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
    const afterAddText = await badge.textContent().catch(() => '')
    const afterAddCount = parseInt(afterAddText ?? '0', 10) || 0
    expect(afterAddCount).toBe(initialCount + 1)

    // Remove the item using the correct remove-item-* testid rendered by cart-drawer.ts
    const variantId = await cartItem.getAttribute('data-testid').then(id => id?.replace('cart-item-', ''))
    const removeBtn = cartItem.locator(`[data-testid="remove-item-${variantId}"]`)
    await expect(removeBtn).toBeVisible({ timeout: 5000 })
    await removeBtn.click()
    await page.waitForTimeout(800)

    // Cart should be empty again
    const afterRemoveText = await badge.textContent().catch(() => '')
    const afterRemoveCount = parseInt(afterRemoveText ?? '0', 10) || 0
    expect(afterRemoveCount).toBe(initialCount)
  })
})
