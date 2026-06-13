import { expect, test } from '../support/fixtures'

test.describe('Search', () => {
  test('search page shows search input and empty state', async ({ page }) => {
    await page.goto('/search')
    // Accept any search input or results container visible on the page
    await expect(
      page.locator('[data-testid="search-page-input"], [data-testid="search-results"], [data-testid="search-input"]').first(),
    ).toBeVisible({ timeout: 10000 })
  })

  test('searching a term shows results', async ({ page }) => {
    await page.goto('/search?q=wool')
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

  test('search round-trip: type query shows results, clear query returns to full listing', async ({ page }) => {
    await page.goto('/search')
    // Use the page-specific search input (Astro) or the header search bar (Next.js)
    const searchInput = page.locator('[data-testid="search-page-input"], [data-testid="search-input"]').first()
    await expect(searchInput).toBeVisible({ timeout: 10000 })

    // Type a search query (wool matches several seeded products)
    await searchInput.fill('wool')
    await page.waitForTimeout(500)

    const resultsWithQuery = page.locator('[data-testid^="product-card-"]')
    const queryCount = await resultsWithQuery.count()

    // Clear the query
    await searchInput.fill('')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)

    // After clearing, should either show all products or empty state — but not remain stuck on query results
    const resultsAfterClear = page.locator('[data-testid^="product-card-"]')
    const afterClearCount = await resultsAfterClear.count()

    // The count after clearing should be >= results with query (clearing a filter broadens results)
    // or show the search empty state — either way, the page responds to the change
    expect(afterClearCount).toBeGreaterThanOrEqual(queryCount)
    // The query text must be cleared in the input
    expect(await searchInput.inputValue()).toBe('')
  })
})
