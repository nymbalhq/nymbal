import type { APIResponse, BrowserContext, Page } from '@playwright/test'
import { adminToken, ownProduct } from '../support/checkout'
import { API_URL } from '../support/csrf'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { addOneLine, noScript, PRODUCT } from '../support/server-rendered'
import { formatPrice } from '../support/variants'

// P2-19 AC-1, AC-2 and AC-3 (spec P2-19-fragments-and-isr, Decisions 3 and 4; store end state caching.fragments-cached),
// on production builds of both templates (playwright.prod.config.ts). AC-1: `/fragments/header`, `/footer`, `/nav` and
// `/product/<seed slug>`, each requested with and without a `nymbal.cart` cookie holding one line, answer 200
// `text/html` holding the one element in a declarative shadow root (read from the parsed DOM with JavaScript off): the
// header with `/`'s nav links, the footer with `/`'s columns, the category nav with a card per `GET /api/categories`
// item in order, the product card with `GET /api/products/<slug>`'s name and price; `Cache-Control` carries `s-maxage`
// 3600 / 86400 / 21600 / 300 and neither `private` nor `no-store`; no `Set-Cookie`; the header fragment's mini-cart has
// no `count` and an empty badge, cookie or not. AC-2: an unknown product fragment is a 404 a CDN never stores
// (`no-store`). AC-3 (Next): the second request for a fragment is `x-nextjs-cache: HIT` with the first one's body.
// Kills: no fragment routes on Next; a fragment that renders another element or stale props; a fragment that reads the
// cart cookie (one shopper's count cached for all); a fragment that is private, no-store or has no s-maxage; a
// Set-Cookie that makes a CDN refuse it; an unknown product's 404 a CDN caches; a fragment route Next renders every time.

interface Fragment {
  path: string
  tag: string
  sMaxage: number
}

const FRAGMENTS: Fragment[] = [
  { path: '/fragments/header', tag: 'nymbal-site-header', sMaxage: 3600 },
  { path: '/fragments/footer', tag: 'nymbal-site-footer', sMaxage: 86_400 },
  { path: '/fragments/nav', tag: 'nymbal-category-nav', sMaxage: 21_600 },
  { path: `/fragments/product/${PRODUCT}`, tag: 'nymbal-product-card', sMaxage: 300 },
]

const contexts: BrowserContext[] = []

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close()
})

/** Two JS-off contexts: one holding a shopper's one-line cart cookie, one with no cookie. */
async function visitors(
  browser: Parameters<typeof noScript>[0],
  testInfo: Parameters<typeof noScript>[1],
): Promise<Array<{ label: string; context: BrowserContext }>> {
  const baseURL = testInfo.project.use.baseURL
  const on = await browser.newContext(baseURL === undefined ? {} : { baseURL })
  await addOneLine(on)
  const withCart = await noScript(browser, testInfo, on)
  const without = await noScript(browser, testInfo)
  contexts.push(on, withCart, without)
  const cookies = (await withCart.cookies()).map((c) => c.name)
  expect(cookies, 'the shopper context holds the cart cookie').toContain('nymbal.cart')
  return [
    { label: 'with a one-line cart cookie', context: withCart },
    { label: 'with no cookie', context: without },
  ]
}

async function open(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage()
  await blockExternalRequests(page)
  const response = await page.goto(path)
  expect(response?.status(), `GET ${path}`).toBe(200)
  return page
}

const header = (res: APIResponse, name: string): string[] =>
  res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === name)
    .map((h) => h.value)

/** The `s-maxage` seconds of a Cache-Control value, or null. */
function sMaxage(cacheControl: string): number | null {
  const match = /(?:^|[,\s])s-maxage=(\d+)/i.exec(cacheControl)
  return match === null ? null : Number(match[1])
}

/** The response's headers as a CDN reads them: status, type, Cache-Control and any Set-Cookie. */
async function expectShareable(context: BrowserContext, fragment: Fragment, label: string) {
  const res = await context.request.get(fragment.path)
  const what = `${fragment.path} ${label}`
  expect(res.status(), what).toBe(200)
  // A fragment has no <meta charset>: without the header's, a browser or an edge parses "£" as "Â£".
  expect(res.headers()['content-type'], `${what} content-type`).toMatch(
    /^text\/html;\s*charset=utf-8$/i,
  )
  const cacheControl = header(res, 'cache-control').join(', ')
  expect(sMaxage(cacheControl), `${what} Cache-Control "${cacheControl}"`).toBe(fragment.sMaxage)
  expect(cacheControl, `${what} Cache-Control`).not.toMatch(/\b(private|no-store)\b/i)
  expect(header(res, 'set-cookie'), `${what} Set-Cookie`).toEqual([])
}

/** The fragment's one element, rendered by the server into a declarative shadow root. */
async function hostOf(page: Page, tag: string) {
  const host = page.locator(tag)
  await expect(host, `${tag} in the fragment`).toHaveCount(1)
  expect(await host.evaluate((el) => el.shadowRoot !== null), `${tag} has a shadow root`).toBe(true)
  return host
}

const hrefs = (page: Page, selector: string): Promise<string[]> =>
  page.locator(selector).evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))

const texts = async (page: Page, selector: string): Promise<string[]> =>
  (await page.locator(selector).allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())

test.describe('P2-19 AC-1: the fragment routes (production build)', () => {
  test('AC-1: caching.fragments-cached: /fragments/header, with and without a cart cookie, is nymbal-site-header with /’s nav links, a mini-cart with no count and an empty badge, s-maxage=3600, shareable, no Set-Cookie', async ({
    browser,
  }, testInfo) => {
    const fragment = FRAGMENTS[0]!
    const visits = await visitors(browser, testInfo)
    const home = await open(visits[1]!.context, '/')
    const homeLinks = await hrefs(home, 'nymbal-site-header [part~="link"]')
    expect(homeLinks.length, '/’s header nav links').toBeGreaterThan(0)

    for (const { label, context } of visits) {
      await expectShareable(context, fragment, label)
      const page = await open(context, fragment.path)
      await hostOf(page, fragment.tag)
      expect(await hrefs(page, 'nymbal-site-header [part~="link"]'), label).toEqual(homeLinks)
      const miniCart = page.locator('nymbal-site-header nymbal-mini-cart')
      await expect(miniCart, `${label}: the header’s mini-cart`).toHaveCount(1)
      expect(await miniCart.getAttribute('count'), `${label}: mini-cart count`).toBeNull()
      expect(
        (await miniCart.getByTestId('mini-cart-badge').textContent())?.trim(),
        `${label}: badge`,
      ).toBe('')
    }
  })

  test('AC-1: caching.fragments-cached: /fragments/footer, with and without a cart cookie, is nymbal-site-footer with /’s columns, s-maxage=86400, shareable, no Set-Cookie', async ({
    browser,
  }, testInfo) => {
    const fragment = FRAGMENTS[1]!
    const visits = await visitors(browser, testInfo)
    const home = await open(visits[1]!.context, '/')
    const homeHeadings = await texts(home, 'nymbal-site-footer [part~="heading"]')
    const homeLinks = await hrefs(home, 'nymbal-site-footer [part~="link"]')
    expect(homeHeadings.length, '/’s footer columns').toBeGreaterThan(0)

    for (const { label, context } of visits) {
      await expectShareable(context, fragment, label)
      const page = await open(context, fragment.path)
      await hostOf(page, fragment.tag)
      expect(await texts(page, 'nymbal-site-footer [part~="heading"]'), label).toEqual(homeHeadings)
      expect(await hrefs(page, 'nymbal-site-footer [part~="link"]'), label).toEqual(homeLinks)
    }
  })

  test('AC-1: caching.fragments-cached: /fragments/nav, with and without a cart cookie, is nymbal-category-nav with one card per GET /api/categories item in order, s-maxage=21600, shareable, no Set-Cookie', async ({
    browser,
    request,
  }, testInfo) => {
    const fragment = FRAGMENTS[2]!
    const res = await request.get(`${API_URL}/api/categories`)
    expect(res.status()).toBe(200)
    const categories = ((await res.json()) as { data: Array<{ slug: string }> }).data
    expect(categories.length, 'seeded categories').toBeGreaterThan(0)
    const visits = await visitors(browser, testInfo)

    for (const { label, context } of visits) {
      await expectShareable(context, fragment, label)
      const page = await open(context, fragment.path)
      await hostOf(page, fragment.tag)
      const cards = await page
        .locator('nymbal-category-nav [part~="card"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
      expect(cards, label).toEqual(categories.map((c) => `category-${c.slug}`))
    }
  })

  test('AC-1: caching.fragments-cached: /fragments/product/<seed slug>, with and without a cart cookie, is nymbal-product-card with GET /api/products/<slug>’s name and price, s-maxage=300, shareable, no Set-Cookie', async ({
    browser,
    request,
  }, testInfo) => {
    const fragment = FRAGMENTS[3]!
    const res = await request.get(`${API_URL}/api/products/${PRODUCT}`)
    expect(res.status()).toBe(200)
    const product = (
      (await res.json()) as {
        data: {
          slug: string
          name: string
          currency?: string
          variants: Array<{ priceMinor: number }>
        }
      }
    ).data
    const from = Math.min(...product.variants.map((v) => v.priceMinor))
    const visits = await visitors(browser, testInfo)

    for (const { label, context } of visits) {
      await expectShareable(context, fragment, label)
      const page = await open(context, fragment.path)
      const card = await hostOf(page, fragment.tag)
      await expect(card.getByTestId(`product-card-${product.slug}`), label).toHaveCount(1)
      await expect(card.locator('[part~="name"]'), label).toHaveText(product.name)
      await expect(card.locator('[part~="price"]'), label).toHaveText(
        formatPrice(from, product.currency ?? 'GBP'),
      )
    }
  })
})

test.describe('P2-19 AC-2: an unknown product fragment (production build)', () => {
  test('AC-2: GET /fragments/product/no-such-slug answers 404 with Cache-Control no-store, so a CDN never stores it', async ({
    request,
  }) => {
    const res = await request.get('/fragments/product/no-such-slug')
    expect(res.status()).toBe(404)
    const cacheControl = header(res, 'cache-control').join(', ')
    expect(cacheControl, `Cache-Control "${cacheControl}"`).toMatch(/\bno-store\b/i)
  })
})

test.describe('P2-19 AC-3: Next serves a fragment from its cache (production build)', () => {
  test('AC-3: caching.fragments-cached: the second GET /fragments/nav and /fragments/product/<slug> answer 200 with x-nextjs-cache: HIT and the first one’s body @nextjs', async ({
    request,
  }) => {
    // A product of this test's own: its fragment's first request is the route's first.
    const own = await ownProduct(request, await adminToken(request), 3)
    for (const path of ['/fragments/nav', `/fragments/product/${own.slug}`]) {
      const first = await request.get(path)
      expect(first.status(), `first GET ${path}`).toBe(200)
      const firstBody = await first.text()
      const second = await request.get(path)
      expect(second.status(), `second GET ${path}`).toBe(200)
      expect(second.headers()['x-nextjs-cache'], `second GET ${path}: x-nextjs-cache`).toBe('HIT')
      expect(await second.text(), `second GET ${path}: body`).toBe(firstBody)
    }
  })
})
