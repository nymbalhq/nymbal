import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// P1-11 diff review M3 on both templates: a product card shows the product's "from" price, `priceRange.minMinor`, the
// field the price sorts order by, in the server render and after the client re-renders the grid for a new sort. A card
// showing the first variant's price puts a product shown at £20.00 ahead of a £15.00 one under price-asc.
// Kills: the cards (Astro's ProductCard and plp.ts, Next's ProductCard) formatting `priceMinor`.
//
// The product goes in a seeded category whose seeded prices are all above its cheapest variant (not `apparel`, which
// the listing screenshot needs to hold seeded products only), so it is on that category's first page in every order.

const CATEGORY = 'books'
const VARIANT_PRICES = [2000, 1000] as const

interface ListedProduct {
  slug: string
  currency: string
  priceRange: { minMinor: number; maxMinor: number } | null
}

/** The templates' price format (`formatPrice` in each template's `lib/format.ts`). */
const formatPrice = (minor: number, currency: string): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)

/** An active product in `CATEGORY` whose first variant costs more than its second, served before this returns. */
async function twoPriceProduct(request: APIRequestContext): Promise<string> {
  const categories = await request.get(`${API_URL}/api/categories`)
  expect(categories.status()).toBe(200)
  const category = (
    (await categories.json()) as { data: Array<{ id: string; slug: string }> }
  ).data.find((c) => c.slug === CATEGORY)
  expect(category, `seeded category ${CATEGORY}`).not.toBeUndefined()

  const token = await adminToken(request)
  const tag = randomUUID().slice(0, 8)
  const slug = `p1-11-from-${tag}`
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: {
      slug,
      name: `From Price ${tag}`,
      description: 'A product whose first variant is not its cheapest.',
      status: 'active',
      type: 'variable',
      categoryIds: [category!.id],
      variants: VARIANT_PRICES.map((priceMinor, i) => ({
        sku: `P111-FROM-${tag}-${i}`,
        name: `Size ${i}`,
        priceMinor,
        stock: 5,
        options: [{ name: 'Size', value: String(i) }],
      })),
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  await expect
    .poll(async () => (await listed(request)).some((p) => p.slug === slug), { timeout: 10_000 })
    .toBe(true)
  return slug
}

/** The category's products under price-asc, as the storefront API lists them. */
async function listed(request: APIRequestContext): Promise<ListedProduct[]> {
  const res = await request.get(`${API_URL}/api/products?category=${CATEGORY}&sort=price-asc`)
  expect(res.status()).toBe(200)
  return ((await res.json()) as { data: { items: ListedProduct[] } }).data.items
}

/** Every money amount the card shows, e.g. ["£10.00"]. */
async function shownPrices(card: Locator): Promise<string[]> {
  return (await card.innerText()).match(/£\s?[\d,]+\.\d{2}/g) ?? []
}

const card = (page: Page, slug: string) => page.getByTestId(`product-card-${slug}`)

test.describe('Browse: the card price', () => {
  test('M3: under price-asc, the card of a product with variants [£20, £10] shows the API’s from price, £10.00, server-rendered and after a client sort', async ({
    page,
    request,
  }) => {
    const slug = await twoPriceProduct(request)
    const product = (await listed(request)).find((p) => p.slug === slug)!
    expect(product.priceRange?.minMinor).toBe(Math.min(...VARIANT_PRICES))
    const fromPrice = formatPrice(product.priceRange!.minMinor, product.currency)

    // Server render of the sorted URL.
    await page.goto(`/category/${CATEGORY}?sort=price-asc`)
    await expect(card(page, slug)).toBeVisible({ timeout: 10_000 })
    expect(await shownPrices(card(page, slug))).toEqual([fromPrice])

    // The grid the client renders when the shopper picks the sort.
    await page.goto(`/category/${CATEGORY}`)
    await page.waitForLoadState('networkidle')
    await page.getByTestId('sort-dropdown').selectOption('price-asc')
    await expect(page).toHaveURL(/[?&]sort=price-asc(&|$)/)
    await expect(async () => {
      // The grid is the re-rendered price-asc one: its first card is the API's cheapest.
      const cheapest = (await listed(request))[0]!.slug
      await expect(page.locator('[data-testid^="product-card-"]').first()).toHaveAttribute(
        'data-testid',
        `product-card-${cheapest}`,
        { timeout: 1_000 },
      )
      expect(await shownPrices(card(page, slug))).toEqual([fromPrice])
    }).toPass({ timeout: 10_000 })
  })
})
