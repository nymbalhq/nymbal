import { randomUUID } from 'node:crypto'
import type { APIResponse, BrowserContext, Page } from '@playwright/test'
import {
  adminToken,
  keyedOrderPath,
  openCheckout,
  orderKeyOf,
  orderNumberOf,
  ownProduct,
  walkToPayment,
} from '../support/checkout'
import { API_URL } from '../support/csrf'
import { apiPage, cardSlugs } from '../support/elements'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { addOneLine, apiCart, noScript, PRODUCT } from '../support/server-rendered'
import { formatPrice } from '../support/variants'

// AC-4 and AC-5, on the Next production build (playwright.prod.config.ts; every test is @nextjs).
// AC-4: the second request for `/` and for `/product/<seed slug>` is served from Next's cache (`x-nextjs-cache: HIT`,
// or `STALE` once the window has passed) with `s-maxage=300` and `s-maxage=60`; `/` shows the API's eight newest
// products in order, the PDP the API's first-variant price; neither has a Set-Cookie; requested with a one-line cart
// cookie, the header's mini-cart has no `count` in the HTML, and with JS on its badge fills to the cart's quantity sum.
// AC-5 (a regression guard beside AC-4): `/cart`, `/checkout`, `/order/<n>` and `/account` are never a cache HIT and
// are `private` or `no-store`, and with JS off the header on `/cart` and `/checkout` still shows the cookie's count.
// AC-14: a shopper's recently-viewed list is never in a cached page: with the shopper's cookies, `/` and a product
// page are still served from the cache, their HTML holds a bare `nymbal-recently-viewed` (no shadow root, no card),
// and with JS on the element shows the list `GET /api/recently-viewed` serves that shopper.

const contexts: BrowserContext[] = []

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close()
})

const CACHED = new Set(['HIT', 'STALE'])

const headerValues = (res: APIResponse, name: string): string[] =>
  res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === name)
    .map((h) => h.value)

function sMaxage(cacheControl: string): number | null {
  const match = /(?:^|[,\s])s-maxage=(\d+)/i.exec(cacheControl)
  return match === null ? null : Number(match[1])
}

/** Two requests for `path`; the second, as a shared cache sees it. */
async function secondRequest(
  request: { get(url: string): Promise<APIResponse> },
  path: string,
): Promise<{
  status: number
  cache: string | undefined
  cacheControl: string
  setCookie: string[]
}> {
  const first = await request.get(path)
  expect(first.status(), `first GET ${path}`).toBe(200)
  const second = await request.get(path)
  return {
    status: second.status(),
    cache: second.headers()['x-nextjs-cache'],
    cacheControl: headerValues(second, 'cache-control').join(', '),
    setCookie: [...headerValues(first, 'set-cookie'), ...headerValues(second, 'set-cookie')],
  }
}

async function open(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage()
  await blockExternalRequests(page)
  const response = await page.goto(path)
  expect(response?.status(), `GET ${path}`).toBe(200)
  return page
}

/** A shopper with one line in the cart (JS on), a JS-off context holding the same cookie, and the cart's quantity sum. */
async function shopper(
  browser: Parameters<typeof noScript>[0],
  testInfo: Parameters<typeof noScript>[1],
) {
  const baseURL = testInfo.project.use.baseURL
  const on = await browser.newContext(baseURL === undefined ? {} : { baseURL })
  await addOneLine(on)
  const off = await noScript(browser, testInfo, on)
  contexts.push(on, off)
  const cart = await apiCart(on)
  return { on, off, count: cart.items.reduce((n, line) => n + line.qty, 0) }
}

test.describe('AC-4: Next’s home and product pages are ISR (production build)', () => {
  test('AC-4: caching.next-isr: the second GET / is served from Next’s cache with s-maxage=300 and no Set-Cookie, and / shows the API’s eight newest products in order @nextjs', async ({
    browser,
    request,
  }, testInfo) => {
    const second = await secondRequest(request, '/')
    expect(second.status).toBe(200)
    expect(CACHED.has(second.cache ?? ''), `x-nextjs-cache ${second.cache}`).toBe(true)
    expect(sMaxage(second.cacheControl), `Cache-Control "${second.cacheControl}"`).toBe(300)
    expect(second.cacheControl).not.toMatch(/\bprivate\b/i)
    expect(second.setCookie, 'Set-Cookie').toEqual([])

    const off = await noScript(browser, testInfo)
    contexts.push(off)
    const shown = await cardSlugs((await open(off, '/')).locator('main nymbal-product-grid'))
    expect(shown.length, 'featured cards').toBe(8)
    // The page is the API's eight newest when it was rendered; other journeys add products since, and products are
    // only ever added, so it is the run of eight that starts where its first card now stands.
    const newest = (await apiPage(request, { limit: '100' })).items.map((p) => p.slug)
    const start = newest.indexOf(shown[0]!)
    expect(start, `${shown[0]} among the API's products`).toBeGreaterThanOrEqual(0)
    expect(shown).toEqual(newest.slice(start, start + 8))
  })

  test('AC-4: caching.next-isr: the second GET /product/<seed slug> is served from Next’s cache with s-maxage=60 and no Set-Cookie, and shows GET /api/products/<slug>’s first-variant price @nextjs', async ({
    browser,
    request,
  }, testInfo) => {
    const path = `/product/${PRODUCT}`
    const second = await secondRequest(request, path)
    expect(second.status).toBe(200)
    expect(CACHED.has(second.cache ?? ''), `x-nextjs-cache ${second.cache}`).toBe(true)
    expect(sMaxage(second.cacheControl), `Cache-Control "${second.cacheControl}"`).toBe(60)
    expect(second.cacheControl).not.toMatch(/\bprivate\b/i)
    expect(second.setCookie, 'Set-Cookie').toEqual([])

    const res = await request.get(`${API_URL}/api/products/${PRODUCT}`)
    expect(res.status()).toBe(200)
    const product = (
      (await res.json()) as { data: { currency: string; variants: Array<{ priceMinor: number }> } }
    ).data
    const off = await noScript(browser, testInfo)
    contexts.push(off)
    const page = await open(off, path)
    await expect(page.locator('main nymbal-product-price').getByTestId('product-price')).toHaveText(
      formatPrice(product.variants[0]!.priceMinor, product.currency),
    )
  })

  test('AC-4: caching.next-isr: with a one-line cart cookie, the HTML of / and the PDP carries no count on the header’s nymbal-mini-cart; with JS on, its badge fills to the sum of GET /api/cart’s quantities @nextjs', async ({
    browser,
  }, testInfo) => {
    const { on, off, count } = await shopper(browser, testInfo)
    expect(count, 'the cart’s quantity sum').toBeGreaterThan(0)

    for (const path of ['/', `/product/${PRODUCT}`]) {
      const html = await open(off, path)
      const miniCart = html.locator('nymbal-site-header nymbal-mini-cart')
      await expect(miniCart, `${path}: the header’s mini-cart`).toHaveCount(1)
      expect(await miniCart.getAttribute('count'), `${path}: count in the cached HTML`).toBeNull()

      const page = await open(on, path)
      await expect(
        page.locator('nymbal-site-header nymbal-mini-cart').getByTestId('mini-cart-badge'),
        `${path}: the JS-on badge`,
      ).toHaveText(String(count), { timeout: 15_000 })
    }
  })
})

test.describe('AC-5: the shopper pages stay live (production build)', () => {
  test('AC-5: caching.shopper-pages-live: /cart, /checkout, /order/<n> of a completed checkout and /account never answer x-nextjs-cache: HIT on a second request, and their Cache-Control is private or no-store @nextjs', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await blockExternalRequests(page)
    const product = await ownProduct(request, await adminToken(request), 5)
    await openCheckout(page, product)
    await walkToPayment(page, `e2e-fragments-${randomUUID().slice(0, 8)}@e2e.test`)
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const orderNumber = orderNumberOf(page)

    const live: string[] = []
    for (const path of [
      '/cart',
      '/checkout',
      keyedOrderPath(orderNumber, orderKeyOf(page)),
      '/account',
    ]) {
      for (const [who, client] of [
        ['the shopper', page.request],
        ['no cookie', request],
      ] as const) {
        await client.get(path)
        const second = await client.get(path)
        const cache = second.headers()['x-nextjs-cache']
        const cacheControl = headerValues(second, 'cache-control').join(', ')
        if (cache === 'HIT') live.push(`${path} (${who}): x-nextjs-cache HIT`)
        if (!/\b(private|no-store)\b/i.test(cacheControl))
          live.push(`${path} (${who}): Cache-Control "${cacheControl}"`)
      }
    }
    expect(live).toEqual([])
  })

  test('AC-5: caching.shopper-pages-live: with JS off and a one-line cart cookie, the header’s nymbal-mini-cart badge on /cart and /checkout shows the cart’s count, 1 @nextjs', async ({
    browser,
  }, testInfo) => {
    const { off, count } = await shopper(browser, testInfo)
    expect(count).toBe(1)
    for (const path of ['/cart', '/checkout']) {
      const page = await open(off, path)
      const badges = page
        .locator('nymbal-site-header nymbal-mini-cart')
        .getByTestId('mini-cart-badge')
      const texts = (await badges.allTextContents()).map((t) => t.trim())
      expect(texts.length, `${path}: header mini-cart badges`).toBeGreaterThan(0)
      expect(texts, path).toEqual(texts.map(() => String(count)))
    }
  })
})

/** The markup inside the page's `nymbal-recently-viewed`, or null when the HTML has none. */
function recentlyViewedIn(html: string): string | null {
  const match = /<nymbal-recently-viewed\b[^>]*>([\s\S]*?)<\/nymbal-recently-viewed>/.exec(html)
  return match === null ? null : match[1]!
}

/** What `GET /api/recently-viewed` serves this context (its cookies), by product slug. */
async function servedList(context: BrowserContext): Promise<string[]> {
  const res = await context.request.get(`${API_URL}/api/recently-viewed`)
  expect(res.status(), 'GET /api/recently-viewed').toBe(200)
  return ((await res.json()) as { data: { items: Array<{ slug: string }> } }).data.items.map(
    (p) => p.slug,
  )
}

/** Opens a product page with JS on and waits for its view to be captured. */
async function viewed(context: BrowserContext, slug: string): Promise<Page> {
  const page = await context.newPage()
  await blockExternalRequests(page)
  const captured = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/recently-viewed',
    { timeout: 15_000 },
  )
  const response = await page.goto(`/product/${slug}`)
  expect(response?.status(), `GET /product/${slug}`).toBe(200)
  await expect(page.getByTestId('recently-viewed'), `${slug}'s page holds the element`).toHaveCount(
    1,
  )
  expect((await captured).status(), `the view of ${slug}`).toBe(204)
  return page
}

test.describe('AC-14: recently viewed stays out of the cached pages (production build)', () => {
  test('AC-14: recently-viewed.cached-pages-anonymous: with views of A and B, the second GET / and /product/<A> are served from Next’s cache, their nymbal-recently-viewed has no shadow root and no card of A or B, and with JS on it shows the list GET /api/recently-viewed serves (B on A’s page; A then B on /) @nextjs', async ({
    browser,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const a = await ownProduct(request, token, 5)
    const b = await ownProduct(request, token, 5)
    const baseURL = testInfo.project.use.baseURL
    const shopper = await browser.newContext(baseURL === undefined ? {} : { baseURL })
    contexts.push(shopper)
    for (const product of [a, b]) await (await viewed(shopper, product.slug)).close()
    await expect.poll(() => servedList(shopper), { timeout: 10_000 }).toEqual([b.slug, a.slug])

    for (const path of ['/', `/product/${a.slug}`]) {
      const second = await secondRequest(shopper.request, path)
      expect(second.status, path).toBe(200)
      expect(CACHED.has(second.cache ?? ''), `${path}: x-nextjs-cache ${second.cache}`).toBe(true)
      const html = await (await shopper.request.get(path)).text()
      const inside = recentlyViewedIn(html)
      expect(inside, `${path}: nymbal-recently-viewed in the HTML`).not.toBeNull()
      expect(inside, `${path}: a server-rendered shadow root`).not.toMatch(/shadowrootmode/i)
      for (const product of [a, b]) {
        expect(inside, `${path}: ${product.slug}'s card in the cached HTML`).not.toContain(
          `product-card-${product.slug}`,
        )
      }
    }

    // A's page with JS on records A again and shows the rest of the list; / then shows the list the API serves.
    const pdp = await viewed(shopper, a.slug)
    await expect.poll(() => servedList(shopper), { timeout: 10_000 }).toEqual([a.slug, b.slug])
    const onPdp = (await servedList(shopper)).filter((slug) => slug !== a.slug)
    await expect
      .poll(() => cardSlugs(pdp.getByTestId('recently-viewed')), { timeout: 15_000 })
      .toEqual(onPdp)
    expect(onPdp).toEqual([b.slug])
    const home = await open(shopper, '/')
    const listed = await servedList(shopper)
    await expect
      .poll(() => cardSlugs(home.getByTestId('recently-viewed')), { timeout: 15_000 })
      .toEqual(listed)
    expect(listed).toEqual([a.slug, b.slug])
  })
})
