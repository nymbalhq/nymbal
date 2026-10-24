import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// auth-checkout runs after successful login + cart add
test.describe('Auth checkout flow', () => {
  test('registered user can see account link in nav', async ({ page }) => {
    await page.goto('/')
    // The account link is nymbal-site-header's `account` part.
    const accountLink = page
      .locator('nymbal-site-header [part~="account"]')
      .filter({ visible: true })
      .first()
    await expect(accountLink).toBeVisible({ timeout: 10000 })
    await expect(accountLink).toHaveAttribute('href', /\/account/)
  })

  test('register flow redirects to account on success', async ({ page }) => {
    const uniqueEmail = `test-${Date.now()}@e2e.test`
    await page.goto('/account/register', { waitUntil: 'load' })
    // nymbal-register-form asks for the password twice; a mismatch registers nothing.
    await page.getByTestId('register-email').fill(uniqueEmail)
    await page.getByTestId('register-password').fill('TestPassword123!')
    await page.getByTestId('register-confirmPassword').fill('TestPassword123!')
    await page.getByTestId('register-submit').click()
    // `/account` itself: the register page's own path also matches /\/account/.
    await page.waitForURL((url) => url.pathname === '/account', { timeout: 15000 })
    // The account exists, not just a redirect: the API signs in with the credentials the form registered.
    const login = await page.request.post(`${API_URL}/api/auth/login`, {
      headers: await csrf(page.request),
      data: { email: uniqueEmail, password: 'TestPassword123!' },
    })
    expect(login.status(), `POST /api/auth/login: ${await login.text()}`).toBe(200)
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken
    expect(token.length).toBeGreaterThan(0)
  })
})
