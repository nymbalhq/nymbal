import { storeCapabilities } from '../support/capabilities'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// Acceptance tests for P2-09 AC-8 (spec P2-09-dev-stage, decision 6; P2-05 `search-bar-absent`): on the no-search
// store (tests/e2e/fixtures/no-search, search `custom` with no capability), run as the astro-nosearch and
// nextjs-nosearch targets, GET /api/capabilities reports search without `search`, and the header renders no
// `search-input` on the home page, /products and a product page, while each page renders (the product's name shows)
// and no console message mentions search. The fixtures' autoFailOnErrors fails any page error besides.
// Tagged @nosearch: only those targets run it, and they run nothing else.
// Kills: a header that renders the bar whatever the store reports, and a no-search branch that crashes a page.

interface Listed {
  data: { items: Array<{ slug: string; name: string }> }
}

test.describe('@nosearch the store reports no search', () => {
  test('AC-8: GET /api/capabilities reports search capabilities without `search`', async ({
    request,
  }) => {
    const caps = await storeCapabilities(request)

    expect(Array.isArray(caps.search.capabilities)).toBe(true)
    expect(caps.search.capabilities.filter((c) => c === 'search')).toEqual([])
  })

  test('AC-8: home, /products and a product page render with no search-input in the header, and no console message mentions search', async ({
    page,
    request,
  }) => {
    const listed = await request.get(`${API_URL}/api/products?limit=1`)
    expect(listed.status()).toBe(200)
    const product = ((await listed.json()) as Listed).data.items[0]
    expect(product, 'the no-search store has a seeded product').toBeTruthy()

    const aboutSearch: string[] = []
    page.on('console', (msg) => {
      if (/search/i.test(msg.text()) && ['error', 'warning'].includes(msg.type())) {
        aboutSearch.push(`${msg.type()}: ${msg.text()}`)
      }
    })

    await page.goto('/')
    await expect(page.getByTestId('mini-cart')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('search-input')).toHaveCount(0)

    await page.goto('/products')
    const cards = page.locator('[data-testid^="product-card-"]')
    await expect(cards.first()).toBeVisible({ timeout: 15000 })
    expect(await cards.count()).toBeGreaterThan(0)
    await expect(page.getByTestId('search-input')).toHaveCount(0)

    await page.goto(`/product/${product!.slug}`)
    await expect(page.getByTestId('product-title')).toHaveText(product!.name, { timeout: 15000 })
    await expect(page.getByTestId('search-input')).toHaveCount(0)

    expect(aboutSearch).toEqual([])
  })
})
