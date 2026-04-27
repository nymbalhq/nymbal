import { expect, test } from '../support/fixtures'

test('guest can complete a purchase end-to-end', async ({ page }) => {
  await page.goto('/products')
  await expect(page.locator('[data-testid^="product-card-"]').first()).toBeVisible({ timeout: 15000 })

  await page.locator('[data-testid^="product-card-"]').first().click()
  await expect(page.locator('[data-testid="add-to-cart"]')).toBeVisible({ timeout: 15000 })
  await page.locator('[data-testid="add-to-cart"]').click()

  await page.waitForSelector('[data-testid="cart-checkout-btn"]', { timeout: 10000 })
  await page.locator('[data-testid="cart-checkout-btn"]').click()
  await expect(page).toHaveURL(/\/checkout/, { timeout: 10000 })

  // Contact step
  await page.locator('[data-testid="contact-email"]').fill('test@example.com')
  await page.locator('[data-testid="contact-continue"]').click()

  // Shipping step
  await page.locator('[data-testid="shipping-firstName"]').fill('Test')
  await page.locator('[data-testid="shipping-lastName"]').fill('User')
  await page.locator('[data-testid="shipping-addressLine1"]').fill('123 Test Street')
  await page.locator('[data-testid="shipping-city"]').fill('Manchester')
  await page.locator('[data-testid="shipping-region"]').fill('Greater Manchester')
  await page.locator('[data-testid="shipping-postalCode"]').fill('M1 1AA')
  await page.locator('[data-testid="shipping-country"]').fill('GB')
  await page.locator('[data-testid="shipping-continue"]').click()

  // Payment step — native-stub skips Stripe
  await expect(page.locator('[data-testid="place-order"]')).toBeVisible({ timeout: 10000 })
  await page.locator('[data-testid="place-order"]').click()

  // Order confirmation
  await page.waitForURL(/\/order\//, { timeout: 20000 })
  await expect(page.locator('[data-testid="order-number"]')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-testid="order-number"]')).toContainText(/^(NYM|INT)-/)
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
    page.locator('[data-testid="contact-email"]'),
  ).toBeVisible({ timeout: 10000 })
})
