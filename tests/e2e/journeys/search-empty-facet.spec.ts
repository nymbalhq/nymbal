import { randomUUID } from 'node:crypto'
import { storeCapabilities } from '../support/capabilities'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// A search whose hits carry no category: the API answers a `category` facet with no values, which is no filter. The
// page draws no filter group and no filter column; the results start where the page's content does.

interface ApiSearch {
  data: {
    items: Array<{ slug: string }>
    total: number
    facets: Array<{ field: string; values: Array<{ value: string }> }>
  }
}

const PRODUCTS = 2

test('AC-5: search.no-empty-facet-column: /search?q=<token> whose hits have no category, on a store whose search reports facet, answers a category facet with no values and shows no filter-group-* and no column before search-results', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const capabilities = await storeCapabilities(request)
  expect(capabilities.search.capabilities, 'the store’s search reports facet').toContain('facet')

  const token = `nofacetcol${randomUUID().replace(/-/g, '').slice(0, 10)}`
  const auth = await adminToken(request)
  const slugs: string[] = []
  for (let i = 0; i < PRODUCTS; i++) {
    const slug = `search-${token}-${i}`
    const res = await request.post(`${API_URL}/api/admin/products`, {
      headers: { ...(await csrf(request)), authorization: `Bearer ${auth}` },
      data: {
        slug,
        name: `Uncategorised ${token} Item ${i}`,
        description: 'A product with no category.',
        status: 'active',
        variants: [
          { sku: `NF-${token}-${i}`, name: 'Default', priceMinor: 1200, stock: 5, options: [] },
        ],
      },
    })
    expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
    slugs.push(slug)
  }

  const read = async (): Promise<ApiSearch['data']> => {
    const res = await request.get(`${API_URL}/api/products/search?q=${token}&limit=50`)
    return ((await res.json()) as ApiSearch).data
  }
  await expect.poll(async () => (await read()).items.length, { timeout: 15_000 }).toBe(PRODUCTS)
  const api = await read()
  expect(api.facets.find((f) => f.field === 'category')?.values, 'the category facet').toEqual([])

  // The browser's own search settles the filter: absence is judged once it has answered and the page has rendered it.
  const searched = page.waitForResponse(
    (r) =>
      r.url().includes('/api/products/search') && new URL(r.url()).searchParams.get('q') === token,
  )
  await page.goto(`/search?q=${token}`)
  expect((await searched).status()).toBe(200)
  for (const slug of slugs) {
    await expect(page.getByTestId(`product-card-${slug}`)).toBeVisible({ timeout: 15_000 })
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await page
    .locator('nymbal-product-filter')
    .evaluateAll((filters) =>
      Promise.all(
        filters.map((f) => (f as Element & { updateComplete?: Promise<unknown> }).updateComplete),
      ),
    )

  // The content's left edge is the `.container` both templates put the results in (Astro's title is centred in a
  // hero above it, so the title's edge is not the content's there).
  const offset = await page.getByTestId('search-results').evaluate((results) => {
    const container = results.closest('.container')
    if (container === null) throw new Error('search-results is in no .container')
    const style = getComputedStyle(container)
    const contentLeft =
      container.getBoundingClientRect().left +
      parseFloat(style.borderLeftWidth) +
      parseFloat(style.paddingLeft)
    return results.getBoundingClientRect().left - contentLeft
  })
  expect(Math.abs(offset), 'search-results starts at the content’s left edge').toBeLessThanOrEqual(
    1,
  )
  await expect(page.locator('[data-testid^="filter-group-"]')).toHaveCount(0)
})
