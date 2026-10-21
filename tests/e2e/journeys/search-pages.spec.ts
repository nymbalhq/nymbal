import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { storeCapabilities } from '../support/capabilities'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// P2-07 AC-8 (decision 8) on every storefront target: astro, nextjs, and the fixture store's astro-custom and
// nextjs-custom. The file creates products of its own sharing a unique token term, across two seeded categories, so
// the expectation is the API read at the moment of the assertion, over products no other journey touches.
// The admin API cannot create a category, so the two are seeded ones that no other journey needs to hold seeded
// products only: not `apparel` (the listing screenshot refuses a product created after the seed) and not `books`
// (the card price journey needs its product on that category's first page).
// - Every target: /search?q=<token> shows `search-total` with the API's total, and its first page plus
//   `search-load-more` clicks until the button is gone show exactly the API's full cursor walk.
// - When GET /api/capabilities reports `facet` for search: choosing `filter-option-<slug>` shows exactly the API's
//   `category=<slug>` walk and total, writes `?category=` beside `?q`, and a reload of that URL shows the same.
// - When it does not: the page renders no `filter-group-*`, and the API answers `facets: []` for the same match.
// Kills: a template that counts the cards it rendered, has no load more, builds facets itself, or renders a filter
// its search cannot serve.

const PRODUCTS = 26
const CATEGORY_SLUGS = ['home', 'electronics'] as const

interface ApiSearchPage {
  items: Array<{ slug: string }>
  nextCursor: string | null
  total: number
  facets: Array<{ field: string; values: Array<{ value: string }> }>
}

interface Seeded {
  token: string
  slugs: string[]
  categories: Array<{ id: string; slug: string }>
}

let seeded: Seeded

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext()
  try {
    const categoriesRes = await request.get(`${API_URL}/api/categories`)
    expect(categoriesRes.status(), 'GET /api/categories').toBe(200)
    const all = ((await categoriesRes.json()) as { data: Array<{ id: string; slug: string }> }).data
    const categories = CATEGORY_SLUGS.map((slug) => all.find((c) => c.slug === slug))
    expect(
      categories.map((c) => c?.slug),
      `seeded categories ${CATEGORY_SLUGS.join(', ')}`,
    ).toEqual([...CATEGORY_SLUGS])
    const [a, b] = categories as [{ id: string; slug: string }, { id: string; slug: string }]

    const token = `sp${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const auth = await adminToken(request)
    const slugs: string[] = []
    for (let i = 0; i < PRODUCTS; i++) {
      // Most in one category or the other, a few in both.
      const categoryIds = i < 13 ? [a.id] : i < 23 ? [b.id] : [a.id, b.id]
      const slug = `p2-07-${token}-${i}`
      const res = await request.post(`${API_URL}/api/admin/products`, {
        headers: { ...(await csrf(request)), authorization: `Bearer ${auth}` },
        data: {
          slug,
          name: `Search Pages ${token} Item ${i}`,
          description: 'A product of the search pages journey.',
          status: 'active',
          categoryIds,
          variants: [
            {
              sku: `SP-${token}-${i}`,
              name: 'Default',
              priceMinor: 1500 + i,
              stock: 5,
              options: [],
            },
          ],
        },
      })
      expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
      slugs.push(slug)
    }
    // Served by search before any page opens.
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_URL}/api/products/search?q=${token}&limit=100`)
          return ((await res.json()) as { data: ApiSearchPage }).data.items.length
        },
        { timeout: 15_000 },
      )
      .toBe(PRODUCTS)
    seeded = { token, slugs, categories }
  } finally {
    await request.dispose()
  }
})

/** The API's full cursor walk for the query, at a page size of its own, and its total. */
async function apiWalk(
  request: APIRequestContext,
  query: { q: string; category?: string },
): Promise<{ slugs: string[]; total: number; facets: ApiSearchPage['facets'] }> {
  const slugs: string[] = []
  let cursor: string | null = null
  let first: ApiSearchPage | undefined
  for (let pages = 0; pages < 50; pages++) {
    const params = new URLSearchParams({ q: query.q, limit: '7' })
    if (query.category !== undefined) params.set('category', query.category)
    if (cursor !== null) params.set('cursor', cursor)
    const res = await request.get(`${API_URL}/api/products/search?${params.toString()}`)
    expect(res.status(), `GET /api/products/search?${params.toString()}`).toBe(200)
    const page = ((await res.json()) as { data: ApiSearchPage }).data
    first ??= page
    slugs.push(...page.items.map((p) => p.slug))
    cursor = page.nextCursor
    if (cursor === null) return { slugs, total: first.total, facets: first.facets }
  }
  throw new Error(`GET /api/products/search ${JSON.stringify(query)}: the cursor walk did not end`)
}

function cards(page: Page): Locator {
  return page.locator('[data-testid^="product-card-"]')
}

async function shownSlugs(page: Page): Promise<string[]> {
  return cards(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-testid')!.slice('product-card-'.length)),
  )
}

/** The page's total, then load more until the button is gone; returns the cards shown. */
async function showAll(page: Page, total: number, most: number): Promise<string[]> {
  await expect(page.getByTestId('search-total')).toContainText(String(total), { timeout: 15_000 })
  await expect(cards(page).first()).toBeVisible({ timeout: 15_000 })
  const loadMore = page.getByTestId('search-load-more')
  for (let clicks = 0; clicks <= most && (await loadMore.count()) > 0; clicks++) {
    const before = await cards(page).count()
    await loadMore.click()
    await expect.poll(() => cards(page).count(), { timeout: 15_000 }).toBeGreaterThan(before)
  }
  await expect(loadMore).toHaveCount(0)
  return shownSlugs(page)
}

test.describe('Search pages: total, load more and the category facet', () => {
  test('AC-8: /search?q=<token> shows the API’s total, and the first page plus load more until it is gone show exactly the API’s full cursor walk', async ({
    page,
    request,
  }) => {
    const api = await apiWalk(request, { q: seeded.token })
    await page.goto(`/search?q=${seeded.token}`)
    const shown = await showAll(page, api.total, api.slugs.length)
    expect(shown).toEqual(api.slugs)
    // The comparison means something: the walk is every product made, once each, and the total counts it.
    expect(new Set(api.slugs).size, 'the API walk repeats a product').toBe(api.slugs.length)
    expect([...api.slugs].sort(), 'the API walk is the products made').toEqual(
      [...seeded.slugs].sort(),
    )
    expect(api.total).toBe(api.slugs.length)
  })

  test('AC-8: the category filter is there iff search reports facet: choosing an option shows the API’s category walk and total, writes ?category= beside ?q, and a reload shows the same; without facet there is no filter and the API sends facets []', async ({
    page,
    request,
  }) => {
    const canFacet = (await storeCapabilities(request)).search.capabilities.includes('facet')
    const full = await apiWalk(request, { q: seeded.token })
    await page.goto(`/search?q=${seeded.token}`)
    await expect(page.getByTestId('search-total')).toContainText(String(full.total), {
      timeout: 15_000,
    })

    if (!canFacet) {
      await page.waitForLoadState('networkidle')
      await expect(page.locator('[data-testid^="filter-group-"]')).toHaveCount(0)
      expect(full.facets).toEqual([])
      return
    }

    const category = seeded.categories[0]!.slug
    const api = await apiWalk(request, { q: seeded.token, category })
    expect(api.slugs.length, 'the category narrows the walk').toBeLessThan(full.slugs.length)
    expect(api.total).toBe(api.slugs.length)

    await expect(page.getByTestId('filter-group-category')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId(`filter-option-${category}`).click()
    await expect
      .poll(() => {
        const url = new URL(page.url())
        return [url.searchParams.get('q'), url.searchParams.get('category')]
      })
      .toEqual([seeded.token, category])
    expect(await showAll(page, api.total, api.slugs.length)).toEqual(api.slugs)

    await page.reload()
    expect(await showAll(page, api.total, api.slugs.length)).toEqual(api.slugs)
  })
})
