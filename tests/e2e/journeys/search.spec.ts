import type { Page } from '@playwright/test'
import { storeCapabilities } from '../support/capabilities'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

interface ApiSearch {
  data: { items: Array<{ slug: string; name: string }> }
}

/** The product-card slugs rendered inside `nymbal-search-results`, through the cards' own shadow roots, in order. */
function slugsInResults(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const host = document.querySelector('nymbal-search-results')
    if (!host?.shadowRoot) return null
    const ids: string[] = []
    const walk = (root: ParentNode): void => {
      for (const node of root.querySelectorAll('*')) {
        const id = node.getAttribute('data-testid')
        if (id?.startsWith('product-card-')) ids.push(id.slice('product-card-'.length))
        if (node.shadowRoot) walk(node.shadowRoot)
      }
    }
    walk(host.shadowRoot)
    return ids
  })
}

test.describe('Search', () => {
  // P2-15 AC-5 (theming.views-are-elements): the results region is `nymbal-search-results` on both templates, its
  // cards `nymbal-product-card`s in its shadow root, and they are the API's results for the term, in its order.
  test('AC-5: theming.views-are-elements: /search?q=wool renders inside nymbal-search-results the slugs GET /api/products/search?q=wool returns, in order', async ({
    page,
  }) => {
    const res = await page.request.get(`${API_URL}/api/products/search?q=wool`)
    expect(res.status()).toBe(200)
    const found = (await res.json()) as ApiSearch
    expect(found.data.items.length, 'no seeded product matches "wool"').toBeGreaterThan(0)

    await page.goto('/search?q=wool')
    await expect
      .poll(() => slugsInResults(page), { timeout: 15_000 })
      .toEqual(found.data.items.map((p) => p.slug))
  })

  test('AC-5: a term GET /api/products/search finds nothing for shows the no-results state and no card', async ({
    page,
  }) => {
    const term = 'zqxjvw'
    const res = await page.request.get(`${API_URL}/api/products/search?q=${term}`)
    expect(res.status()).toBe(200)
    const found = (await res.json()) as ApiSearch
    expect(found.data.items).toHaveLength(0)

    await page.goto(`/search?q=${term}`)
    await expect(page.getByRole('heading', { name: 'No results found' })).toBeVisible({
      timeout: 15000,
    })
    await expect(page.locator('[data-testid^="product-card-"]')).toHaveCount(
      found.data.items.length,
    )
  })

  test('AC-5: searching a seeded term lists the products GET /api/products/search returns for it, in its order and by name', async ({
    page,
  }) => {
    const res = await page.request.get(`${API_URL}/api/products/search?q=wool`)
    expect(res.status()).toBe(200)
    const found = (await res.json()) as ApiSearch
    expect(found.data.items.length, 'no seeded product matches "wool"').toBeGreaterThan(0)

    await page.goto('/search?q=wool')
    const cards = page.locator('[data-testid^="product-card-"]')
    await expect
      .poll(
        () =>
          cards.evaluateAll((els) =>
            els.map((el) => el.getAttribute('data-testid')!.slice('product-card-'.length)),
          ),
        { timeout: 15000 },
      )
      .toEqual(found.data.items.map((p) => p.slug))
    for (const [i, product] of found.data.items.entries()) {
      await expect(cards.nth(i)).toContainText(product.name)
    }
  })

  // P2-05 AC-3: the header search bar renders from the search slot. The branch is the one GET /api/capabilities names
  // (both the native and the custom-providers store report `search`); neither branch skips.
  test('AC-3: the header search bar is present iff search reports search, and submitting a term opens the search page', async ({
    page,
    request,
  }) => {
    const caps = await storeCapabilities(request)
    const canSearch = caps.search.capabilities.includes('search')

    await page.goto('/')
    // The header has rendered its client elements (the mini-cart is one of them) before absence is read.
    await expect(page.getByTestId('mini-cart')).toBeVisible({ timeout: 15000 })
    const searchInput = page.getByTestId('search-input')
    if (!canSearch) {
      await expect(searchInput).toHaveCount(0)
      return
    }
    await expect(searchInput.first()).toBeVisible()
    await searchInput.first().fill('wool')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/search\?(.*&)?q=wool(&|$)/, { timeout: 10000 })
  })

  test('AC-3: search round-trip: type query shows results, clear query returns to the search empty state', async ({
    page,
  }) => {
    await page.goto('/search')
    // Use the page-specific search input (Astro, server-rendered) or the header search bar (Next.js)
    const pageInput = page.getByTestId('search-page-input')
    const searchInput =
      (await pageInput.count()) > 0 ? pageInput : page.getByTestId('search-input').first()
    await expect(searchInput).toBeVisible({ timeout: 10000 })
    // The empty-query state both templates share
    const emptyState = page.getByRole('heading', { name: 'Search our store' })

    // Query results: page cards (Astro) or the search bar's result items (Next.js header)
    const queryResults = page.locator(
      '[data-testid^="product-card-"], [data-testid^="search-result-"]',
    )
    const productCards = page.locator('[data-testid^="product-card-"]')

    // Type a search query (wool matches several seeded products)
    await searchInput.fill('wool')
    await expect(queryResults.first()).toBeVisible({ timeout: 15000 })
    const queryResultIds = await queryResults.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')),
    )
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

  // P1-09 AC-8: choosing a suggestion in the header search bar opens that product's page (Next pushed /products/<slug>,
  // a 404). The term is a seeded product's name from the API's own search; the expected page is whichever suggestion is first.
  test('AC-8: choosing the first header suggestion for a seeded product lands on that product page, HTTP 200', async ({
    page,
  }) => {
    const api = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'
    const found = await page.request.get(`${api}/api/products/search?q=wool&limit=1`)
    expect(found.status()).toBe(200)
    const seeded = ((await found.json()) as { data: { items: Array<{ name: string }> } }).data
      .items[0]
    expect(seeded, 'no seeded product matches "wool"').toBeTruthy()

    await page.goto('/')
    const input = page.getByTestId('search-input').first()
    await input.fill(seeded!.name)
    const firstSuggestion = page.locator('[data-testid^="search-result-"]').first()
    await expect(firstSuggestion).toHaveAttribute('data-slug', /\S/, { timeout: 15000 })
    const slug = await firstSuggestion.getAttribute('data-slug')
    const chosen = await page.request.get(`${api}/api/products/${encodeURIComponent(slug!)}`)
    expect(chosen.status()).toBe(200)
    const chosenName = ((await chosen.json()) as { data: { name: string } }).data.name

    await input.press('ArrowDown')
    await input.press('Enter')

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(chosenName, {
      timeout: 15000,
    })
    expect(new URL(page.url()).pathname).toContain(slug!)
    const landed = await page.request.get(page.url())
    expect(landed.status()).toBe(200)
  })
})
