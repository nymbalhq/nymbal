import type { Page } from '@playwright/test'
import { API_URL } from '../support/csrf'
import { blockExternalRequests, expect, test } from '../support/fixtures'

const PAGES = [
  { name: 'homepage', path: '/' },
  { name: 'cart-empty', path: '/cart' },
  { name: 'search', path: '/search' },
  { name: 'account-login', path: '/account/login' },
  { name: 'account-register', path: '/account/register' },
  { name: 'not-found', path: '/this-page-does-not-exist' },
]

// The product listing (sidebar, sort bar, grid, cards) is shot on a seeded category page, not on /products. Other
// journeys create uncategorized products while this file runs (`ownProduct`, the sort journey), and /products lists
// them on its first page (first under `newest`, between seeded slugs under slug order), so its first screen and its
// facet counts differ run to run. A seeded category holds only seeded products, all created in one instant, so its
// grid, its order (ties by slug) and its facet counts (built from categorized products) are the same every run.
const LISTING_CATEGORY = 'apparel'

test.beforeEach(async ({ page }) => {
  // AC-12: screenshots must not depend on external hosts (product images)
  await blockExternalRequests(page)
  // Disable CSS animations for stable screenshots
  await page.addStyleTag({
    content: `*, *::before, *::after {
      transition: none !important;
      animation: none !important;
      animation-duration: 0s !important;
    }`,
  })
})

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  // Wait for fonts
  await page.evaluate(() => document.fonts.ready)
}

const SHOT = { fullPage: false, maxDiffPixelRatio: 0.01 }

for (const { name, path } of PAGES) {
  test(`${name} @visual`, async ({ page }) => {
    await page.goto(path)
    await settle(page)
    await expect(page).toHaveScreenshot(`${name}.png`, SHOT)
  })
}

test('product listing @visual', async ({ page, request }) => {
  const query = `category=${LISTING_CATEGORY}&limit=24`
  const res = await request.get(`${API_URL}/api/products?${query}`)
  expect(res.status(), `GET /api/products?${query}: ${await res.text()}`).toBe(200)
  const listed = (
    (await res.json()) as { data: { items: Array<{ slug: string; createdAt: string }> } }
  ).data.items

  // The shot is stable only while the category holds the seeded products alone: they share the seed's one instant,
  // and a product another journey put in this category would not.
  expect(
    new Set(listed.map((product) => product.createdAt)).size,
    `${LISTING_CATEGORY} holds a product created after the seed; the listing screenshot would vary`,
  ).toBe(1)

  await page.goto(`/category/${LISTING_CATEGORY}`)
  await settle(page)
  // What is shot is the API's category, in its order, and nothing else.
  const shown = await page
    .locator('[data-testid^="product-card-"]')
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute('data-testid')!.slice('product-card-'.length)),
    )
  expect(shown).toEqual(listed.map((product) => product.slug))

  await expect(page).toHaveScreenshot('product-listing.png', SHOT)
})
