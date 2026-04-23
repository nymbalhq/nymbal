import { expect, test } from '@playwright/test'

test('homepage renders hero section and product cards', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-testid="hero-section"]')).toBeVisible({ timeout: 15000 })
  const productCards = page.locator('[data-testid^="product-card-"]')
  await expect(productCards.first()).toBeVisible({ timeout: 15000 })
})
