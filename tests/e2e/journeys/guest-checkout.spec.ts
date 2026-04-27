import { expect, test } from '../support/fixtures'

test.describe('Guest checkout flow', () => {
  test('checkout page is accessible from cart', async ({ page }) => {
    // Add item to cart first
    await page.goto('/products')
    await page.locator('[data-testid^="product-card-"]').first().click()
    await page.waitForSelector('[data-testid="add-to-cart"]')
    await page.locator('[data-testid="add-to-cart"]').click()
    await page.waitForSelector('[data-testid="cart-checkout-btn"]', { timeout: 10000 })
    await page.locator('[data-testid="cart-checkout-btn"]').click()
    await expect(page).toHaveURL(/\/checkout/, { timeout: 10000 })
  })

  test('checkout page shows step indicator', async ({ page }) => {
    await page.goto('/checkout')
    await expect(
      page.locator('[data-testid="checkout-steps"]'),
    ).toBeVisible({ timeout: 10000 })
  })

  test('checkout page shows email field', async ({ page }) => {
    await page.goto('/checkout')
    await expect(
      page.locator('[data-testid="checkout-email"], input[type="email"]').first(),
    ).toBeVisible({ timeout: 10000 })
  })
})
