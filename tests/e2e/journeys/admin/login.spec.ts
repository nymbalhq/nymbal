import { API_URL, csrf } from '../../support/csrf'
import { blockExternalRequests, expect, test } from '../../support/fixtures'

test.describe('Admin login', () => {
  test('invalid credentials show the API’s refusal and stay on /login', async ({
    page,
    request,
  }) => {
    const credentials = { email: 'wrong@example.com', password: 'wrongpassword' }
    const refused = await request.post(`${API_URL}/api/auth/login`, {
      headers: await csrf(request, API_URL),
      data: credentials,
    })
    expect(refused.status()).toBe(401)

    await page.goto('login')
    await page.getByTestId('admin-login-email').fill(credentials.email)
    await page.getByTestId('admin-login-password').fill(credentials.password)
    await page.getByTestId('admin-login-submit').click()
    await expect(page.getByTestId('admin-login-error')).toHaveText(
      ((await refused.json()) as { error: { message: string } }).error.message,
    )
    await expect(page).toHaveURL(/\/login/)
  })

  test('login page snapshot @visual', async ({ page }) => {
    // AC-12: screenshots must not depend on external hosts
    await blockExternalRequests(page)
    await page.goto('login')
    await expect(page.getByTestId('admin-login-form')).toBeVisible()
    await expect(page).toHaveScreenshot('admin-login.png', { fullPage: true })
  })

  test('login page is accessible @a11y', async ({ page }) => {
    const AxeBuilder = (await import('@axe-core/playwright')).default
    await page.goto('login')
    await page.waitForLoadState('networkidle')
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })
})
