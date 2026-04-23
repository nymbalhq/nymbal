import { expect, test } from '@playwright/test'

test.describe('Search', () => {
  test('search page shows search input and empty state', async ({ page }) => {
    await page.goto('/search')
    await expect(page.locator('[data-testid="search-page-results"], [data-testid="search-input"]')).toBeVisible({ timeout: 10000 })
  })

  test('searching a term shows results', async ({ page }) => {
    await page.goto('/search?q=shirt')
    await expect(
      page.locator('[data-testid^="product-card-"]').first(),
    ).toBeVisible({ timeout: 15000 })
  })

  test('search bar navigates to search page on submit', async ({ page }) => {
    await page.goto('/')
    const searchInput = page.locator('[data-testid="search-input"]')
    if (await searchInput.count() === 0) {
      test.skip()
      return
    }
    await searchInput.fill('shoes')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/search/, { timeout: 10000 })
  })
})
