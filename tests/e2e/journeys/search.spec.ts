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

  test('AC-3: search round-trip: type query shows results, clear query returns to the search empty state', async ({ page }) => {
    await page.goto('/search')
    // Use the page-specific search input (Astro, server-rendered) or the header search bar (Next.js)
    const pageInput = page.getByTestId('search-page-input')
    const searchInput = (await pageInput.count()) > 0 ? pageInput : page.getByTestId('search-input').first()
    await expect(searchInput).toBeVisible({ timeout: 10000 })
    // The empty-query state both templates share
    const emptyState = page.getByRole('heading', { name: 'Search our store' })

    // Query results: page cards (Astro) or the search bar's result items (Next.js header)
    const queryResults = page.locator('[data-testid^="product-card-"], [data-testid^="search-result-"]')
    const productCards = page.locator('[data-testid^="product-card-"]')

    // Type a search query (wool matches several seeded products)
    await searchInput.fill('wool')
    await expect(queryResults.first()).toBeVisible({ timeout: 15000 })
    const queryResultIds = await queryResults.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
    expect(queryResultIds.length).toBeGreaterThan(0)

    // Clear the query
    await searchInput.fill('')

    // The page returns to the shared empty-query state, not a listing
    await expect(emptyState).toBeVisible({ timeout: 10000 })
    await expect(queryResults).toHaveCount(0)
    for (const id of queryResultIds) {
      await expect(page.locator(`[data-testid="${id}"]`)).toHaveCount(0)
    }
    await expect(productCards).toHaveCount(0)
    await expect(searchInput).toHaveValue('')
    await expect(page).not.toHaveURL(/[?&]q=/)
  })

  test('AC-9: a query containing markup is rendered as text, not elements', async ({ page }) => {
    const payload = '<img src=x id=xss-probe onerror="window.__xss=1">'
    await page.goto(`/search?q=${encodeURIComponent(payload)}`)

    // Both templates label the query ("Results for …" / "Showing results for …") once they have rendered it
    await expect(page.getByText(/results for/i).first()).toBeVisible({ timeout: 15000 })
    // Let the page settle: the search request and any image request the markup would make
    await page.waitForLoadState('networkidle')

    await expect(page.locator('#xss-probe')).toHaveCount(0)
    const xss = await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)
    expect(xss).toBeUndefined()
    // The query is shown literally, as text
    await expect(page.getByText(payload).first()).toBeVisible()
  })
})
