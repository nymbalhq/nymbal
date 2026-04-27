import { test, expect } from '../../support/fixtures'

test.describe('Admin login', () => {
  test('login form renders', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByTestId('admin-login-form')).toBeVisible()
    await expect(page.getByTestId('admin-login-email')).toBeVisible()
    await expect(page.getByTestId('admin-login-password')).toBeVisible()
    await expect(page.getByTestId('admin-login-submit')).toBeVisible()
  })

  test('invalid credentials show error and stay on /login', async ({ page }) => {
    await page.goto('/login')
    await page.getByTestId('admin-login-email').fill('wrong@example.com')
    await page.getByTestId('admin-login-password').fill('wrongpassword')
    await page.getByTestId('admin-login-submit').click()
    await expect(page).toHaveURL(/\/login/)
    await expect(
      page.locator('[role="alert"], [data-testid="admin-login-error"]'),
    ).toBeVisible()
  })

  test('login page snapshot @visual', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByTestId('admin-login-form')).toBeVisible()
    await expect(page).toHaveScreenshot('admin-login.png', { fullPage: true })
  })

  test('login page is accessible @a11y', async ({ page }) => {
    const AxeBuilder = (await import('@axe-core/playwright')).default
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    const results = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})
