import { expect, test } from '../support/fixtures'

test.describe('Error pages', () => {
  test('404 page shows branded error page with header', async ({ page }) => {
    await page.goto('/this-page-does-not-exist-404-test')
    // Should show a branded error page, not a blank screen
    await expect(page.locator('[data-testid="site-header"]')).toBeVisible({ timeout: 10000 })
    // Some form of 404 message
    const body = await page.textContent('body')
    expect(body).toMatch(/404|not found|page not found/i)
  })

  test('404 page has navigation back to home', async ({ page }) => {
    await page.goto('/nonexistent-page-xyz')
    await page.waitForLoadState('domcontentloaded')
    const links = page.locator('a[href="/"]')
    await expect(links.first()).toBeVisible({ timeout: 10000 })
  })
})
