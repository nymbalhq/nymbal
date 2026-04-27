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
})
