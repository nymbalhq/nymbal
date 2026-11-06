import type { APIRequestContext, Browser, Page, TestInfo } from '@playwright/test'
import { seedCategories } from '../../../packages/platform/src/seed/data'
import { storeCapabilities } from '../support/capabilities'
import { API_URL } from '../support/csrf'
import { cardSlugs } from '../support/elements'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { noScript } from '../support/server-rendered'

// A listing names its category in the query (`/products?category=<slug>`) or the path (`/category/<slug>`), and both
// the server's HTML and the hydrated grid list what `GET /api/products` lists for it, in its order. Every catalogue
// link in the site header and footer opens such a listing, and a non-empty one.
//
// Other journeys create uncategorized products while this file runs: a category's list stays put, the catalogue's
// first page may not, so a bare `/products` is compared to the API inside a retry.

const PAGE = 24

/** `GET /api/products` for the listing a URL names, in the store's default sort: a category's, or the catalogue's. */
async function apiSlugs(
  request: APIRequestContext,
  sort: string,
  category: string | null,
): Promise<string[]> {
  const params = new URLSearchParams({ limit: String(PAGE), sort })
  if (category !== null) params.set('category', category)
  const res = await request.get(`${API_URL}/api/products?${params.toString()}`)
  expect(res.status(), `GET /api/products?${params.toString()}`).toBe(200)
  const body = (await res.json()) as { data: { items: Array<{ slug: string }> } }
  return body.data.items.map((p) => p.slug)
}

/** The product cards `nymbal-product-grid` holds in `path`'s server HTML, read with JavaScript off. */
async function serverCards(browser: Browser, testInfo: TestInfo, path: string): Promise<string[]> {
  const context = await noScript(browser, testInfo)
  try {
    const page = await context.newPage()
    await blockExternalRequests(page)
    const res = await page.goto(path)
    expect(res?.status(), `GET ${path}`).toBe(200)
    return await cardSlugs(page.locator('nymbal-product-grid'))
  } finally {
    await context.close()
  }
}

/** The category a catalogue link names (`/category/<slug>` or `?category=<slug>`), or null for the whole catalogue. */
function categoryOf(href: string): string | null {
  const url = new URL(href, 'http://store.test')
  if (url.pathname.startsWith('/category/'))
    return decodeURIComponent(url.pathname.slice('/category/'.length))
  return url.searchParams.get('category')
}

/** The hrefs of the chrome's links (`[part~="link"]`) inside `host`, as the server rendered them. */
function chromeLinks(page: Page, host: string): Promise<string[]> {
  return page
    .locator(`${host} [part~="link"]`)
    .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''))
}

test.describe('Listing by category', () => {
  for (const { slug } of seedCategories) {
    test(`AC-4: /products?category=${slug} lists the category GET /api/products?category=${slug} lists, in its order, in the server HTML and after the product-list load`, async ({
      browser,
      page,
      request,
    }, testInfo) => {
      const { defaultSort } = (await storeCapabilities(request)).catalog
      const expected = await apiSlugs(request, defaultSort, slug)
      const path = `/products?category=${slug}`

      expect(await serverCards(browser, testInfo, path), `${path} with JavaScript off`).toEqual(
        expected,
      )

      await blockExternalRequests(page)
      const loaded = page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(API_URL) &&
          new URL(r.url()).pathname === '/api/products',
        { timeout: 15_000 },
      )
      await page.goto(path)
      expect((await loaded).ok(), 'the product-list load').toBe(true)
      await expect
        .poll(() => cardSlugs(page.locator('nymbal-product-grid')), {
          message: `${path} with JavaScript on, once the product-list load settles`,
          timeout: 10_000,
        })
        .toEqual(expected)
    })
  }

  test('AC-5: every catalogue link in the site header and footer opens a non-empty listing whose server-rendered cards are the API’s list for what it names', async ({
    browser,
    request,
  }, testInfo) => {
    test.setTimeout(90_000)
    const { defaultSort } = (await storeCapabilities(request)).catalog

    const context = await noScript(browser, testInfo)
    let hrefs: string[]
    try {
      const page = await context.newPage()
      await blockExternalRequests(page)
      await page.goto('/products')
      hrefs = [
        ...(await chromeLinks(page, 'nymbal-site-header')),
        ...(await chromeLinks(page, 'nymbal-site-footer')),
      ]
    } finally {
      await context.close()
    }
    const catalogue = [
      ...new Set(hrefs.filter((h) => h.startsWith('/products') || h.startsWith('/category/'))),
    ]
    expect(
      catalogue.filter((h) => categoryOf(h) === null),
      'the chrome links the whole catalogue once or more',
    ).toContain('/products')

    for (const href of catalogue) {
      const category = categoryOf(href)
      await expect(async () => {
        const expected = await apiSlugs(request, defaultSort, category)
        const shown = await serverCards(browser, testInfo, href)
        expect(shown, `${href}: the server's cards against the API's list`).toEqual(expected)
        expect(shown.length, `${href} lists products`).toBeGreaterThanOrEqual(1)
      }).toPass({ timeout: 15_000 })
    }
  })
})
