import type { Locator, Page } from '@playwright/test'
import { storeCapabilities } from '../support/capabilities'
import { adminToken, ownProduct } from '../support/checkout'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

/** How many products the homepage features (both templates ask `GET /api/products` for this many). */
const FEATURED = 8

interface ApiListing {
  data: { items: Array<{ slug: string; name: string }> }
}

interface ApiProduct {
  data: { name: string; currency?: string; variants: Array<{ priceMinor: number; stock: number }> }
}

/** A price as a shopper reads it: both templates format minor units in en-GB. */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)
}

/** The badge both templates show for a stock level: out at 0, low under 5 (Next adds "— n left"), else in stock. */
function stockLabel(stock: number): RegExp {
  if (stock <= 0) return /^\s*out of stock\s*$/i
  if (stock < 5) return /^\s*low stock\b/i
  return /^\s*in stock\s*$/i
}

/** The product cards a locator matches, by slug, in document order. */
async function cardSlugs(cards: Locator): Promise<string[]> {
  return cards.evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-testid')!.slice('product-card-'.length)),
  )
}

interface ListingFacet {
  field: string
  values: Array<{ value: string }>
}

/**
 * Opens the PLP and waits until the client's own product load has answered, so a filter clicked next is not
 * overtaken by that load's response (the product-list store keeps whichever response lands last). Returns the cards
 * and the facets that response carried (none when the store's search cannot facet).
 */
async function openListing(page: Page): Promise<{ cards: Locator; facets: ListingFacet[] }> {
  const listed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/products' && r.request().method() === 'GET',
  )
  await page.goto('/products')
  const body = (await (await listed).json()) as { data: { facets?: ListingFacet[] } }
  const cards = page.locator('[data-testid^="product-card-"]')
  await expect(cards.first()).toBeVisible({ timeout: 15000 })
  return { cards, facets: body.data.facets ?? [] }
}

/** The filter as rendered: each group's field and its options' values, sorted, for comparing with the facets. */
async function shownFilter(page: Page): Promise<Array<{ field: string; values: string[] }>> {
  const groups = await page.locator('[data-testid^="filter-group-"]').evaluateAll((els) =>
    els.map((group) => ({
      field: group.getAttribute('data-testid')!.slice('filter-group-'.length),
      values: [...group.querySelectorAll('[data-testid^="filter-option-"]')]
        .map((o) => o.getAttribute('data-testid')!.slice('filter-option-'.length))
        .sort(),
    })),
  )
  return groups.sort((a, b) => a.field.localeCompare(b.field))
}

/** The same shape from the listing's facets. */
function expectedFilter(facets: ListingFacet[]): Array<{ field: string; values: string[] }> {
  return facets
    .map((f) => ({ field: f.field, values: f.values.map((v) => v.value).sort() }))
    .sort((a, b) => a.field.localeCompare(b.field))
}

/** A listing with no facets renders no filter: read once the page has settled, so a late render is seen. */
async function expectNoFilter(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  await expect(page.locator('[data-testid^="filter-group-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="filter-option-"]')).toHaveCount(0)
}

/** How many products a filter option says it matches, from its "(n)" count. */
async function facetCount(option: Locator): Promise<number> {
  const count = option.locator('.nymbal-filter-count')
  await expect(count).toHaveText(/^\(\d+\)$/)
  return Number((await count.textContent())!.replace(/\D/g, ''))
}

test.describe('Browse catalog', () => {
  // The homepage features the first FEATURED products of the API's default (newest) order. Other journeys create
  // products while this runs; a new product goes first and may push known ones down, never reorder them, so the known
  // cards shown must be exactly the first known products in the API's order read after the page.
  test('homepage: under the hero, the featured cards are the first products GET /api/products lists, in its order and by name', async ({
    page,
  }) => {
    const listing = `${API_URL}/api/products?limit=100`
    const before = (await (await page.request.get(listing)).json()) as ApiListing
    const known = new Set(before.data.items.map((p) => p.slug))

    await page.goto('/')
    await expect(page.getByTestId('hero-section')).toBeVisible({ timeout: 15000 })
    const cards = page.locator('[data-testid^="product-card-"]')
    await expect(cards.first()).toBeVisible()
    const shown = await cardSlugs(cards)

    const res = await page.request.get(listing)
    expect(res.status()).toBe(200)
    const after = (await res.json()) as ApiListing
    const bySlug = new Map(after.data.items.map((p) => [p.slug, p]))
    expect(shown.length).toBe(Math.min(FEATURED, after.data.items.length))
    expect(shown.filter((slug) => !bySlug.has(slug))).toEqual([])
    const knownShown = shown.filter((slug) => known.has(slug))
    expect(knownShown).toEqual(
      after.data.items
        .map((p) => p.slug)
        .filter((slug) => known.has(slug))
        .slice(0, knownShown.length),
    )
    for (const [i, slug] of shown.entries()) {
      await expect(cards.nth(i)).toContainText(bySlug.get(slug)!.name)
    }

    // A shown card's link reaches that card's product page. The last card, so a link built from the wrong card or a
    // wrong path (`/products/…`) does not land on the product the shopper clicked.
    const target = shown.length - 1
    const slug = shown[target]!
    await cards.nth(target).click()
    await expect(page).toHaveURL(new RegExp(`/product/${slug}$`), { timeout: 15000 })
    const served = (await (
      await page.request.get(`${API_URL}/api/products/${slug}`)
    ).json()) as ApiProduct
    await expect(page.getByTestId('product-title')).toHaveText(served.data.name, {
      timeout: 15000,
    })
  })

  // One product of the test's own per stock state (out, low, in), so no other journey moves its stock.
  test('AC-3: the product page shows the title, price, stock badge and breadcrumb GET /api/products/:slug gives, for each stock state', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    for (const stock of [0, 3, 12]) {
      const product = await ownProduct(request, token, stock)
      await page.goto(`/product/${product.slug}`)

      const res = await page.request.get(`${API_URL}/api/products/${product.slug}`)
      expect(res.status()).toBe(200)
      const served = (await res.json()) as ApiProduct
      expect(
        served.data.variants[0]!.stock,
        'the API serves the stock the product was made with',
      ).toBe(stock)

      await expect(page.getByTestId('product-title')).toHaveText(served.data.name, {
        timeout: 15000,
      })
      await expect(page.getByTestId('product-price')).toHaveText(
        money(served.data.variants[0]!.priceMinor, served.data.currency ?? 'GBP'),
      )
      await expect(page.getByTestId('stock-badge')).toHaveText(
        stockLabel(served.data.variants[0]!.stock),
      )
      await expect(page.getByTestId('breadcrumb').locator('[aria-current="page"]')).toHaveText(
        served.data.name,
      )
    }
  })

  // AC-3: the filter round-trip takes the branch the listing's facets name: with facets, the filter works; without (a
  // search adapter with no `facet`), there is no filter to use.
  test('filter round-trip: apply filter then remove restores original product count and all filter groups remain visible', async ({
    page,
  }) => {
    const { cards, facets } = await openListing(page)
    if (facets.length === 0) return expectNoFilter(page)
    const filterGroups = page.locator('[data-testid^="filter-group-"]')
    await expect(filterGroups.first()).toBeVisible()
    const filterGroupCount = await filterGroups.count()

    // Capture original product count
    const originalProductCount = await cards.count()
    expect(originalProductCount).toBeGreaterThan(0)

    // Apply the first filter: the listing narrows to the products the option says it matches (at most one page).
    const firstOption = filterGroups.first().locator('[data-testid^="filter-option-"]').first()
    const filteredCount = Math.min(await facetCount(firstOption), originalProductCount)
    const firstCheckbox = firstOption.locator('input[type="checkbox"]')
    await firstCheckbox.click()
    await expect(cards).toHaveCount(filteredCount)
    // All filter groups remain visible after filtering
    await expect(filterGroups).toHaveCount(filterGroupCount)

    // Unclick filter — the original listing comes back
    await firstCheckbox.click()
    await expect(firstCheckbox).not.toBeChecked()
    await expect(cards).toHaveCount(originalProductCount)

    // All filter groups still visible
    await expect(filterGroups).toHaveCount(filterGroupCount)
  })

  // AC-3: the filter is present iff the listing response has facets, rendered from those facets only, and the listing
  // has facets iff the store's search reports `facet`. Both templates are held to the same API answer, so on the native
  // store Astro and Next show the same groups and options.
  test('AC-3: /products shows exactly the listing facets as filter groups and options, and the listing has facets iff search reports facet @capabilities', async ({
    page,
    request,
  }) => {
    const caps = await storeCapabilities(request)
    const { facets } = await openListing(page)

    expect(facets.length > 0, JSON.stringify(caps.search)).toBe(
      caps.search.capabilities.includes('facet'),
    )
    await page.waitForLoadState('networkidle')
    await expect.poll(() => shownFilter(page), { timeout: 10000 }).toEqual(expectedFilter(facets))
  })
})
