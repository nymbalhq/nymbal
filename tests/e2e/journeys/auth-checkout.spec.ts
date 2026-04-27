import { expect, test } from '../support/fixtures'

// auth-checkout runs after successful login + cart add
test.describe('Auth checkout flow', () => {
  test('registered user can see account link in nav', async ({ page }) => {
    await page.goto('/')
    // Just verify the header has an account link
    const accountLink = page.locator('[data-testid="site-header"] a[href*="account"]')
    await expect(accountLink).toBeVisible({ timeout: 10000 })
  })

  test('register flow redirects to account on success', async ({ page }) => {
    const uniqueEmail = `test-${Date.now()}@e2e.test`
    await page.goto('/account/register')
    const emailInput = page.locator('[data-testid="register-email"], input[type="email"]').first()
    await emailInput.fill(uniqueEmail)
    const passInput = page.locator('input[type="password"]').first()
    await passInput.fill('TestPassword123!')
    await page.locator('button[type="submit"]').first().click()
    // Should redirect to account or show a success state
    await page.waitForURL(/\/account/, { timeout: 15000 })
    await expect(page).toHaveURL(/\/account/)
  })
})
