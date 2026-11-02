import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// On both templates the storefront offers only what the store sells. A product of the test's own with three
// variants, one inactive, shows the two active ones as its choices on the PDP; once unpublished, and a second product
// once archived, each answers the not-found page at /product/<slug> and is in no /products page and no search result.

interface Made {
  id: string
  slug: string
}

async function makeProduct(
  request: APIRequestContext,
  token: string,
  slug: string,
  name: string,
  variants: Array<{ size: string; active: boolean }>,
): Promise<Made> {
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: {
      slug,
      name,
      description: 'A product of the unlisted journey.',
      status: 'active',
      type: variants.length > 1 ? 'variable' : 'simple',
      variants: variants.map((v, i) => ({
        sku: `UNL-${slug}-${i}`,
        name: v.size,
        priceMinor: 1500 + i * 100,
        stock: 6,
        options: [{ name: 'Size', value: v.size }],
        status: v.active ? 'active' : 'inactive',
      })),
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  const made = ((await res.json()) as { data: Made }).data
  await expect
    .poll(async () => (await request.get(`${API_URL}/api/products/${made.slug}`)).status(), {
      timeout: 10_000,
    })
    .toBe(200)
  return made
}

async function command(
  request: APIRequestContext,
  token: string,
  product: Made,
  op: 'unpublish' | 'archive',
): Promise<void> {
  const res = await request.post(`${API_URL}/api/admin/products/${product.id}/${op}`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
  })
  expect(res.status(), `${op} ${product.slug}: ${await res.text()}`).toBe(200)
}

/** The product-card slugs inside `nymbal-search-results`, through the cards' shadow roots. */
function searchSlugs(page: Page): Promise<string[] | null> {
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

/** Every card /products shows, following Load more until it is gone. */
async function allListingSlugs(page: Page): Promise<string[]> {
  await page.goto('/products')
  const cards = page.locator('[data-testid^="product-card-"]')
  await expect(cards.first()).toBeVisible({ timeout: 15_000 })
  const loadMore = page.getByTestId('load-more')
  for (let clicks = 0; clicks < 200 && (await loadMore.count()) > 0; clicks++) {
    const before = await cards.count()
    await loadMore.click()
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(before)
  }
  await expect(loadMore).toHaveCount(0)
  return cards.evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-testid')!.slice('product-card-'.length)),
  )
}

test.describe('Unlisted products', () => {
  test('AC-5: a product with one inactive variant of three shows the two active ones as its choices; unpublished, and a second product archived, each shows the not-found page at /product/<slug> and is in no /products page and no search result', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const token = await adminToken(request)
    const term = `unl${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const sizes = [
      { size: 'S', active: true },
      { size: 'M', active: false },
      { size: 'L', active: true },
    ]
    const unpublished = await makeProduct(request, token, `${term}-a`, `Unlisted ${term} A`, sizes)
    const archived = await makeProduct(request, token, `${term}-b`, `Unlisted ${term} B`, [
      { size: 'One', active: true },
    ])

    await page.goto(`/product/${unpublished.slug}`)
    await page.waitForLoadState('networkidle')
    const choices = page.locator('main').locator('[data-testid^="variant-option-"]')
    await expect
      .poll(
        async () =>
          (
            await choices.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!))
          ).sort(),
        {
          timeout: 15_000,
        },
      )
      .toEqual(
        sizes
          .filter((v) => v.active)
          .map((v) => `variant-option-Size-${v.size}`)
          .sort(),
      )

    await page.goto(`/search?q=${term}`)
    await expect
      .poll(async () => (await searchSlugs(page))?.sort() ?? null, { timeout: 15_000 })
      .toEqual([unpublished.slug, archived.slug].sort())

    await command(request, token, unpublished, 'unpublish')
    await command(request, token, archived, 'archive')
    for (const product of [unpublished, archived]) {
      await expect
        .poll(async () => (await request.get(`${API_URL}/api/products/${product.slug}`)).status(), {
          timeout: 10_000,
        })
        .toBe(404)
    }

    for (const product of [unpublished, archived]) {
      const path = `/product/${product.slug}`
      const res = await page.goto(path)
      expect(res!.status(), path).toBe(404)
      await expect(page.locator('body'), path).toContainText(/404|not found/i)
    }

    const listed = await allListingSlugs(page)
    expect(
      listed.filter((slug) => slug === unpublished.slug || slug === archived.slug),
      '/products, every page',
    ).toEqual([])

    await page.goto(`/search?q=${term}`)
    await expect(page.getByRole('heading', { name: 'No results found' })).toBeVisible({
      timeout: 15_000,
    })
    expect(await searchSlugs(page)).toEqual([])
  })
})
