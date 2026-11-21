import { expect, test } from '../support/fixtures'
import { newShopper, registerThroughApi } from '../support/passwords'
import { formReady, signIn } from '../support/sign-in'

// A changed password ends every other session, on both storefronts. The shopper is signed in in two browsers; the
// first changes the password on its profile page and stays signed in across a reload; the second, on its next page
// load, restores its session through one refresh (packages/sdk/src/store/auth-store.ts), is refused, and lands on the
// sign-in page. It reads no mail, so it runs on the native stores.

const onPath = (path: string) => (url: URL) => url.pathname.replace(/\/$/, '') === path
const onAccountHome = onPath('/account')
const onLogin = onPath('/account/login')
const pathOf = (href: string): string => new URL(href).pathname

test.describe('Change password', () => {
  test('AC-25: a password changed in one browser keeps that browser signed in across a reload, and the other browser, on its next page load, is refused and lands on the sign-in page', async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(90_000)
    const shopper = newShopper('change-journey')
    await registerThroughApi(shopper)
    const baseURL = testInfo.project.use.baseURL
    if (baseURL === undefined) throw new Error(`project ${testInfo.project.name} has no baseURL`)
    const other = await browser.newContext({ baseURL })
    try {
      const second = await other.newPage()
      await signIn(page, shopper.email, shopper.password)
      await page.waitForURL(onAccountHome, { timeout: 15_000 })
      await signIn(second, shopper.email, shopper.password)
      await second.waitForURL(onAccountHome, { timeout: 15_000 })

      await page.goto('/account/profile')
      await formReady(page, 'nymbal-change-password-form')
      const form = page.locator('nymbal-change-password-form')
      await form.getByTestId('change-current').fill(shopper.password)
      await form.getByTestId('change-new').fill(`Changed-${shopper.password}`)
      await form.getByTestId('change-submit').click()
      await expect(form.getByTestId('change-done')).toBeVisible({ timeout: 10_000 })

      const beforeReload = page.url()
      await page.reload()
      await expect(page.getByTestId('profile-firstName')).toHaveValue('Ada', { timeout: 10_000 })
      expect(pathOf(page.url()), 'the first browser is still on its profile').toBe(
        pathOf(beforeReload),
      )

      await second.goto('/account')
      await second.waitForURL(onLogin, { timeout: 15_000 })
      expect(onLogin(new URL(second.url()))).toBe(true)
    } finally {
      await other.close()
    }
  })
})
