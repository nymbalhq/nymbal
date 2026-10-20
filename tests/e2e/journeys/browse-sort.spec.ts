import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { storeCapabilities } from '../support/capabilities'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// P1-11 AC-4, AC-7, AC-8, AC-9 on both templates: the grid on /products and on a category page is in the order
// `GET /api/products?sort=<key>` returns, the sort lives in the URL and the server render, "load more" continues the
// same order, and a sort on a category page stays in the category.
//
// Other journeys create products while this file runs (`ownProduct`, uncategorized). Every comparison is therefore
// made against the API read at the moment of the assertion and restricted to the products that existed when the test
// began (`known`): a product created later may push known ones down the page, never reorder them, so the known cards
// on the page must be exactly the first known products in the API's order.
//
// P2-05 AC-4: the keys come from the store, never from this file: the dropdown offers exactly GET /api/capabilities'
// `catalog.sortKeys`, in that order, with `catalog.defaultSort` chosen when the URL names no key or an unknown one,
// and each offered key still sorts the grid as P1-11 requires.

type SortKey = 'newest' | 'price-asc' | 'price-desc' | 'name-asc' | 'name-desc'

const PAGE = 24
const GRID_TIMEOUT = 10_000

interface ApiProduct {
  slug: string
  name: string
  createdAt: string
  priceRange: { minMinor: number } | null
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** The spec's order for a key (Decision 1): the key, then slug ascending; a product with no price last in both price orders. */
function compareBy(key: SortKey) {
  return (a: ApiProduct, b: ApiProduct): number => {
    let c = 0
    if (key === 'newest') c = Date.parse(b.createdAt) - Date.parse(a.createdAt)
    else if (key === 'name-asc') c = byName(a.name, b.name)
    else if (key === 'name-desc') c = byName(b.name, a.name)
    else {
      const pa = a.priceRange?.minMinor ?? null
      const pb = b.priceRange?.minMinor ?? null
      if (pa === null || pb === null) c = pa === pb ? 0 : pa === null ? 1 : -1
      else c = key === 'price-asc' ? pa - pb : pb - pa
    }
    return c !== 0 ? c : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  }
}

/** Adjacent cards whose products are out of the key's order, as "a > b" for the failure message. */
function misordered(slugs: string[], products: ApiProduct[], key: SortKey): string[] {
  const bySlug = new Map(products.map((p) => [p.slug, p]))
  const compare = compareBy(key)
  const out: string[] = []
  for (let i = 1; i < slugs.length; i++) {
    const a = bySlug.get(slugs[i - 1]!)
    const b = bySlug.get(slugs[i]!)
    if (a !== undefined && b !== undefined && compare(a, b) > 0) out.push(`${a.slug} > ${b.slug}`)
  }
  return out
}

/** Every product the API lists under `query`, in its order, across all pages. */
async function apiProducts(
  request: APIRequestContext,
  query: { sort?: SortKey; category?: string } = {},
): Promise<ApiProduct[]> {
  const out: ApiProduct[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < 50; pages++) {
    const params = new URLSearchParams({ limit: '100' })
    if (query.sort !== undefined) params.set('sort', query.sort)
    if (query.category !== undefined) params.set('category', query.category)
    if (cursor !== null) params.set('cursor', cursor)
    const res = await request.get(`${API_URL}/api/products?${params.toString()}`)
    expect(res.status(), `GET /api/products?${params.toString()}: ${await res.text()}`).toBe(200)
    const body = (await res.json()) as { data: { items: ApiProduct[]; nextCursor: string | null } }
    out.push(...body.data.items)
    cursor = body.data.nextCursor
    if (cursor === null) return out
  }
  throw new Error(`GET /api/products ${JSON.stringify(query)}: the cursor walk did not end`)
}

async function apiOrder(
  request: APIRequestContext,
  query: { sort?: SortKey; category?: string },
): Promise<string[]> {
  return (await apiProducts(request, query)).map((p) => p.slug)
}

/** The slugs of the catalogue as it stands now. */
async function knownSlugs(request: APIRequestContext): Promise<Set<string>> {
  return new Set(await apiOrder(request, {}))
}

/** The product cards on the page, in document order. */
async function gridSlugs(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="product-card-"]')
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute('data-testid')!.slice('product-card-'.length)),
    )
}

/** The product cards in the HTML the storefront server renders for `url`, before any script runs. */
async function serverRenderedSlugs(request: APIRequestContext, url: string): Promise<string[]> {
  const res = await request.get(url)
  expect(res.status(), `GET ${url}`).toBe(200)
  const html = await res.text()
  return [...html.matchAll(/data-testid="product-card-([^"]+)"/g)].map((m) => m[1]!)
}

/** The known cards shown, and the first as many known products in the API's order: equal when the grid is right. */
function knownPrefix(
  shown: string[],
  api: string[],
  known: Set<string>,
): { shown: string[]; expected: string[] } {
  const knownShown = shown.filter((slug) => known.has(slug))
  return {
    shown: knownShown,
    expected: api.filter((slug) => known.has(slug)).slice(0, knownShown.length),
  }
}

/** An active, uncategorized product of this file's own, served by the read side before this returns. */
async function createProduct(request: APIRequestContext, priceMinor: number): Promise<string> {
  const token = await adminToken(request)
  const tag = randomUUID().slice(0, 8)
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: {
      slug: `p1-11-${tag}`,
      name: `Sort Journey ${tag}`,
      description: 'A product of the sort journey.',
      status: 'active',
      variants: [{ sku: `P111-${tag}`, name: 'Default', priceMinor, stock: 5, options: [] }],
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  const slug = `p1-11-${tag}`
  await expect
    .poll(async () => (await request.get(`${API_URL}/api/products/${slug}`)).status(), {
      timeout: 10_000,
    })
    .toBe(200)
  return slug
}

/** Opens a listing and lets the client's own first load settle, so a sort chosen next is not overtaken by it. */
async function openListing(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.waitForLoadState('networkidle')
}

test.describe('Browse: sort', () => {
  test('AC-4: with no sort, /products renders the default order server-side and the dropdown shows the default sort', async ({
    page,
    request,
  }) => {
    const { defaultSort } = (await storeCapabilities(request)).catalog
    // A product newer than the seeded catalogue, so newest order differs from slug order.
    await createProduct(request, 4321)
    const known = await knownSlugs(request)

    const html = await serverRenderedSlugs(request, '/products')
    const catalogue = (await apiProducts(request)).filter((p) => known.has(p.slug))
    const ordered = [...catalogue].sort(compareBy(defaultSort as SortKey)).map((p) => p.slug)
    const { shown, expected } = knownPrefix(html, ordered, known)
    expect(html.length).toBeGreaterThanOrEqual(Math.min(PAGE, known.size))
    expect(shown).toEqual(expected)

    await openListing(page, '/products')
    await expect(page.getByTestId('sort-dropdown')).toHaveValue(defaultSort)
  })

  test('AC-4: the dropdown offers exactly catalog.sortKeys from GET /api/capabilities, in that order, on /products and on a category page', async ({
    page,
    request,
  }) => {
    const { sortKeys } = (await storeCapabilities(request)).catalog
    expect(sortKeys.length).toBeGreaterThan(0)
    const categories = (
      (await (await request.get(`${API_URL}/api/categories`)).json()) as {
        data: Array<{ slug: string }>
      }
    ).data
    expect(categories.length).toBeGreaterThan(0)

    for (const path of ['/products', `/category/${categories[0]!.slug}`]) {
      await openListing(page, path)
      const offered = await page
        .getByTestId('sort-dropdown')
        .locator('option')
        .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))
      expect(offered, path).toEqual(sortKeys)
    }
  })

  test('AC-4: an unknown ?sort shows the default sort chosen and the grid in the default order', async ({
    page,
    request,
  }) => {
    const { defaultSort } = (await storeCapabilities(request)).catalog
    const known = await knownSlugs(request)

    await openListing(page, '/products?sort=p2-05-not-a-key')

    await expect(page.getByTestId('sort-dropdown')).toHaveValue(defaultSort)
    await expect(async () => {
      const grid = await gridSlugs(page)
      const { shown, expected } = knownPrefix(
        grid,
        await apiOrder(request, { sort: defaultSort as SortKey }),
        known,
      )
      expect(grid.length).toBeGreaterThanOrEqual(Math.min(PAGE, known.size))
      expect(shown).toEqual(expected)
    }).toPass({ timeout: GRID_TIMEOUT })
  })

  test('AC-7: choosing each key catalog.sortKeys offers renders the grid in the order GET /api/products?sort=<key> returns', async ({
    page,
    request,
  }) => {
    const { sortKeys, defaultSort } = (await storeCapabilities(request)).catalog
    // The default last, so every key is a change from the one before it.
    const keys = [...sortKeys.filter((k) => k !== defaultSort), defaultSort] as SortKey[]
    const known = await knownSlugs(request)
    await openListing(page, '/products')
    const dropdown = page.getByTestId('sort-dropdown')

    for (const key of keys) {
      await dropdown.selectOption(key)
      await expect(async () => {
        const grid = await gridSlugs(page)
        const products = await apiProducts(request, { sort: key })
        const { shown, expected } = knownPrefix(
          grid,
          products.map((p) => p.slug),
          known,
        )
        expect(grid.length, key).toBeGreaterThanOrEqual(Math.min(PAGE, known.size))
        // The grid mirrors the API, and the API's order is the key's order.
        expect(shown, key).toEqual(expected)
        expect(misordered(shown, products, key), key).toEqual([])
      }).toPass({ timeout: GRID_TIMEOUT })
    }
  })

  test('AC-8: price-desc is in the URL, survives a reload server-side, and load more appends the next page in the same order', async ({
    page,
    request,
  }) => {
    // More than one page, with the cheapest product on the second page under price-desc.
    const before = await knownSlugs(request)
    for (let i = before.size; i <= PAGE; i++) await createProduct(request, 1 + i - before.size)
    const known = await knownSlugs(request)
    expect(known.size).toBeGreaterThan(PAGE)

    await openListing(page, '/products')
    await page.getByTestId('sort-dropdown').selectOption('price-desc')
    await expect(page).toHaveURL(/[?&]sort=price-desc(&|$)/)

    // The server render of that URL is already in price-desc order.
    const html = await serverRenderedSlugs(request, page.url())
    const rendered = knownPrefix(html, await apiOrder(request, { sort: 'price-desc' }), known)
    expect(html.length).toBe(PAGE)
    expect(rendered.shown).toEqual(rendered.expected)

    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('sort-dropdown')).toHaveValue('price-desc')
    const firstPage = await gridSlugs(page)
    const reloaded = knownPrefix(firstPage, await apiOrder(request, { sort: 'price-desc' }), known)
    expect(firstPage.length).toBe(PAGE)
    expect(reloaded.shown).toEqual(reloaded.expected)

    await page.getByTestId('load-more').click()
    await expect(async () => {
      const grid = await gridSlugs(page)
      const { shown, expected } = knownPrefix(
        grid,
        await apiOrder(request, { sort: 'price-desc' }),
        known,
      )
      expect(grid.length).toBeGreaterThan(firstPage.length)
      expect(new Set(grid).size).toBe(grid.length)
      expect(grid.slice(0, firstPage.length)).toEqual(firstPage)
      expect(shown).toEqual(expected)
    }).toPass({ timeout: GRID_TIMEOUT })
  })

  test('AC-9: on a category page, choosing a sort keeps every card inside that category', async ({
    page,
    request,
  }) => {
    const res = await request.get(`${API_URL}/api/categories`)
    expect(res.status()).toBe(200)
    const categories = ((await res.json()) as { data: Array<{ slug: string }> }).data
    const total = (await knownSlugs(request)).size
    // The largest category that is still a strict part of the catalogue, so leaving it shows.
    let chosen: { slug: string; size: number } | null = null
    for (const { slug } of categories) {
      const size = (await apiOrder(request, { category: slug })).length
      if (size > 1 && size < total && (chosen === null || size > chosen.size))
        chosen = { slug, size }
    }
    expect(chosen, 'a category with more than one product').not.toBeNull()
    const category = chosen!.slug

    await openListing(page, `/category/${category}`)
    const dropdown = page.getByTestId('sort-dropdown')
    for (const key of ['price-desc', 'name-asc'] as const) {
      await dropdown.selectOption(key)
      await expect(async () => {
        const grid = await gridSlugs(page)
        const inCategory = await apiOrder(request, { category, sort: key })
        expect(
          grid.filter((slug) => !inCategory.includes(slug)),
          key,
        ).toEqual([])
        expect(grid.length, key).toBe(Math.min(PAGE, inCategory.length))
        // The sorted grid, not the page as first rendered.
        expect(grid, key).toEqual(inCategory.slice(0, grid.length))
      }).toPass({ timeout: GRID_TIMEOUT })
    }
  })

  // Store walk (browse.sort): a shopper who sorts before the listing script's own first request has answered. The
  // first browser `GET /api/products?` is held until the price-desc answer has arrived (or 5 s at most), so that
  // answer lands while the first is still in flight. Kills: the script subscribing its grid render only after its first
  // load resolves, so the sorted answer reaches the state with nothing rendering it and the grid keeps the server's
  // newest order under a dropdown and URL that say price-desc.
  test('AC-7: a sort chosen while the first listing request is still in flight renders the grid in GET /api/products?sort=<key> order', async ({
    page,
    request,
  }) => {
    const known = await knownSlugs(request)

    const isListing = (url: string) => /\/api\/products\?/.test(url)
    let sortedArrived!: () => void
    const sorted = new Promise<void>((resolve) => {
      sortedArrived = resolve
    })
    page.on('requestfinished', (req) => {
      if (isListing(req.url()) && /[?&]sort=price-desc(&|$)/.test(req.url())) sortedArrived()
    })
    let firstHeld!: () => void
    const held = new Promise<void>((resolve) => {
      firstHeld = resolve
    })
    await page.route(
      (url) => isListing(url.toString()),
      async (route) => {
        firstHeld()
        await Promise.race([sorted, new Promise((resolve) => setTimeout(resolve, 5_000))])
        await route.continue()
      },
      { times: 1 },
    )

    await page.goto('/products', { waitUntil: 'domcontentloaded' })
    // The listing's client code is running (Astro's script at load, Next's grid once hydrated) and its first request
    // has not answered: the shopper sorts now.
    await held
    await page.getByTestId('sort-dropdown').selectOption('price-desc')
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('sort-dropdown')).toHaveValue('price-desc')
    await expect(page).toHaveURL(/[?&]sort=price-desc(&|$)/)
    await expect(async () => {
      const grid = await gridSlugs(page)
      const products = await apiProducts(request, { sort: 'price-desc' })
      const { shown, expected } = knownPrefix(
        grid,
        products.map((p) => p.slug),
        known,
      )
      expect(grid.length).toBeGreaterThanOrEqual(Math.min(PAGE, known.size))
      expect(shown).toEqual(expected)
    }).toPass({ timeout: GRID_TIMEOUT })
  })
})
