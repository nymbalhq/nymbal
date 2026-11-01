import type { Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL } from '../../support/csrf'
import { phoneWidths } from '../../support/phone-width'

// At a phone's width no admin page is wider than the viewport: the pages admin/phone-width.spec.ts does not measure,
// each once it has rendered. Tagged @phone-width, so only the admin-mobile project runs it, at Pixel 7
// (tests/e2e/playwright.config.ts).

/** Holds the page the browser is on to the phone's width; soft, so one run measures every page. */
async function expectPhoneWidth(page: Page, name: string): Promise<void> {
  const { scrollWidth, innerWidth, viewport, measured } = await phoneWidths(page, name)
  expect.soft(scrollWidth, measured).toBeLessThanOrEqual(viewport + 1)
  expect.soft(innerWidth, measured).toBe(viewport)
}

test.describe('Admin at a phone’s width @phone-width', () => {
  test('sign-in, settings, activity and a missing page are each no wider than the viewport', async ({
    page,
    request,
  }) => {
    const main = page.locator('main')
    // Settings shows a row per field the listing carries, or its empty state when no slot takes keys from it.
    const listing = await request.get(`${API_URL}/api/admin/settings`, {
      headers: { authorization: `Bearer ${await adminToken(request)}` },
    })
    expect(listing.status()).toBe(200)
    const { slots } = ((await listing.json()) as { data: { slots: Array<{ fields: unknown[] }> } })
      .data
    const fields = slots.reduce((n, slot) => n + slot.fields.length, 0)

    const served = await page.goto('login')
    expect(served?.status(), `GET ${page.url()}: is the admin served here?`).toBe(200)
    await expect(page.getByTestId('admin-login-submit')).toBeVisible()
    await expectPhoneWidth(page, 'login')
    await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
    await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('admin-login-submit').click()
    await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
      timeout: 15_000,
    })

    const pages: Array<{ name: string; path: string; ready: () => Promise<void> }> = [
      {
        name: 'settings',
        path: 'settings',
        ready: () =>
          slots.length === 0
            ? expect(main.getByRole('heading', { name: 'Nothing to set here' })).toBeVisible()
            : expect(main.locator('[data-testid^="settings-field-"]')).toHaveCount(fields),
      },
      {
        name: 'activity',
        path: 'activity',
        ready: () => expect(page.getByTestId('activity-export')).toBeVisible(),
      },
      {
        name: 'not-found',
        path: 'no-such-page',
        ready: () => expect(main).toContainText('Page not found'),
      },
    ]

    for (const { name, path, ready } of pages) {
      await page.goto(path)
      await ready()
      // Skeletons are placeholders of fixed size; the page is measured once its data has replaced them.
      await expect(main.locator('.animate-pulse')).toHaveCount(0, { timeout: 10_000 })
      await expectPhoneWidth(page, name)
    }
  })
})
