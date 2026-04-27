import { expect, test } from '../support/fixtures'

test.describe('Browse catalog', () => {
  test('homepage shows hero and product cards', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-testid="hero-section"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid^="product-card-"]').first()).toBeVisible()
  })

  test('PLP shows product grid and sort dropdown', async ({ page }) => {
    await page.goto('/products')
    await expect(page.locator('[data-testid^="product-card-"]').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="sort-dropdown"]')).toBeVisible()
  })

  test('PDP shows product title and add-to-cart button', async ({ page }) => {
    await page.goto('/products')
    const firstCard = page.locator('[data-testid^="product-card-"]').first()
    await firstCard.click()
    await expect(page.locator('[data-testid="product-title"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="add-to-cart"]')).toBeVisible()
  })

  test('breadcrumb is visible on PDP', async ({ page }) => {
    await page.goto('/products')
    await page.locator('[data-testid^="product-card-"]').first().click()
    await expect(page.locator('[data-testid="breadcrumb"]')).toBeVisible({ timeout: 15000 })
  })

  test('stock badge is visible on PDP', async ({ page }) => {
    await page.goto('/products')
    await page.locator('[data-testid^="product-card-"]').first().click()
    await expect(page.locator('[data-testid="stock-badge"]')).toBeVisible({ timeout: 15000 })
  })
})
