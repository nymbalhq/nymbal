import { expect, test } from '@playwright/test'

test.describe('Account flows', () => {
  test('login page renders login form', async ({ page }) => {
    await page.goto('/account/login')
    await expect(page.locator('[data-testid="login-form"], [data-testid="login-email"]')).toBeVisible({ timeout: 10000 })
  })

  test('register page renders register form', async ({ page }) => {
    await page.goto('/account/register')
    await expect(page.locator('[data-testid="register-form"], [data-testid="register-email"]')).toBeVisible({ timeout: 10000 })
  })

  test('unauthenticated account access redirects to login', async ({ page }) => {
    await page.goto('/account')
    await page.waitForLoadState('networkidle')
    const url = page.url()
    // Should either redirect to login or show login form
    expect(url.includes('/login') || await page.locator('[data-testid="login-form"]').count() > 0).toBe(true)
  })

  test('login with bad credentials shows error', async ({ page }) => {
    await page.goto('/account/login')
    const emailInput = page.locator('[data-testid="login-email"], input[type="email"]').first()
    await emailInput.fill('notexist@example.com')
    const passInput = page.locator('[data-testid="login-password"], input[type="password"]').first()
    await passInput.fill('wrongpassword')
    await page.locator('[data-testid="login-submit"], button[type="submit"]').first().click()
    // Error should appear somewhere on the page
    await expect(
      page.locator('.error, [role="alert"], [data-testid*="error"]'),
    ).toBeVisible({ timeout: 10000 })
  })
})
