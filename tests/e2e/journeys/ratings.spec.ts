import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Browser, Page, TestInfo } from '@playwright/test'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { noScript } from '../support/server-rendered'

// On both templates a shopper comparing products sees each one's rating where they choose: a product with approved
// reviews shows its average to one decimal and its approved count on its card in the listing and in search results,
// in the server HTML and once the page has upgraded, and its product page says the same above its reviews and in the
// Product JSON-LD. A product with only a pending and a rejected review shows no rating and has no aggregateRating.
//
// The test reviews only products it creates, priced below anything else in the store, so under price-asc they lead the
// catalogue listing's first page whatever other journeys create; the listing screenshot's seeded category stays
// unrated. Reviews come from shoppers through POST /api/reviews and are moderated through the admin API before any
// page is opened. A page that reads a cached catalogue is reloaded until the figures show.

const PASSWORD = 'TestPassword123!'
const RELOADED = { timeout: 120_000, intervals: [1_000, 5_000, 10_000] }

interface Created {
  id: string
  slug: string
}

/** An active product of the test's own named with `term`, at `priceMinor`, served before this returns. */
async function productOf(
  request: APIRequestContext,
  token: string,
  term: string,
  label: string,
  priceMinor: number,
): Promise<Created> {
  const slug = `${term}-${label.toLowerCase()}`
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: {
      slug,
      name: `Rated ${label} ${term}`,
      description: 'A product of the ratings journey.',
      status: 'active',
      variants: [
        { sku: `RATED-${term}-${label}`, name: 'Default', priceMinor, stock: 5, options: [] },
      ],
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  const id = ((await res.json()) as { data: { id: string } }).data.id
  await expect
    .poll(async () => (await request.get(`${API_URL}/api/products/${slug}`)).status(), {
      timeout: 10_000,
    })
    .toBe(200)
  return { id, slug }
}

/** A shopper registered through the API, holding its bearer. */
async function shopperToken(request: APIRequestContext): Promise<string> {
  const email = `rater-${randomUUID().slice(0, 8)}@e2e.test`
  const res = await request.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(request),
    data: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Rater' },
  })
  expect(res.status(), `POST /api/auth/register: ${await res.text()}`).toBe(201)
  return ((await res.json()) as { data: { accessToken: string } }).data.accessToken
}

/** The shopper's review of the product through POST /api/reviews; answers its id. */
async function reviewed(
  request: APIRequestContext,
  shopper: string,
  productId: string,
  rating: number,
): Promise<string> {
  const res = await request.post(`${API_URL}/api/reviews`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${shopper}` },
    data: { productId, rating, title: `Rated ${rating}`, body: 'A review of the ratings journey.' },
  })
  expect(res.status(), `POST /api/reviews: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: { review: { id: string } } }).data.review.id
}

async function moderate(
  request: APIRequestContext,
  token: string,
  reviewId: string,
  status: 'approved' | 'rejected',
): Promise<void> {
  const res = await request.post(`${API_URL}/api/admin/reviews/${reviewId}/moderate`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: { status },
  })
  expect(res.status(), `moderate ${reviewId}: ${await res.text()}`).toBe(200)
}

/** Text as a shopper reads it beside the stars: the star glyphs out, whitespace collapsed. */
const words = (text: string): string => text.replace(/[★☆]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Waits for every Nymbal element, in the light DOM or any shadow root, to be done updating, once the page holds a
 * `tag` host and every one of them is defined.
 */
async function upgradedAll(page: Page, tag: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (tag) => {
          const hosts: Element[] = []
          const walk = (root: Document | ShadowRoot): void => {
            for (const el of Array.from(root.querySelectorAll('*'))) {
              if (el.localName.startsWith('nymbal-')) hosts.push(el)
              if (el.shadowRoot) walk(el.shadowRoot)
            }
          }
          walk(document)
          const own = hosts.filter((h) => h.localName === tag)
          if (own.length === 0 || own.some((h) => !h.matches(':defined'))) return false
          for (const host of hosts) {
            await (host as Element & { updateComplete?: Promise<unknown> }).updateComplete
          }
          return true
        }, tag),
      { timeout: 15_000, message: `${tag} upgraded` },
    )
    .toBe(true)
}

/** What the page shows of each product's card: how many cards it has, and the words of each card's rating part. */
async function cardsOf(
  page: Page,
  products: Record<string, Created>,
): Promise<Record<string, { cards: number; ratings: string[] }>> {
  const out: Record<string, { cards: number; ratings: string[] }> = {}
  for (const [label, p] of Object.entries(products)) {
    const card = page.locator(`[data-testid="product-card-${p.slug}"]`)
    out[label] = {
      cards: await card.count(),
      ratings: (await card.locator('[part~="rating"]').allTextContents()).map(words),
    }
  }
  return out
}

/** The page's Product JSON-LD objects. */
async function productJsonLd(page: Page): Promise<Array<Record<string, unknown>>> {
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents()
  return scripts
    .map((s) => JSON.parse(s) as Record<string, unknown> | Array<Record<string, unknown>>)
    .flatMap((ld) => (Array.isArray(ld) ? ld : [ld]))
    .filter((ld) => ld['@type'] === 'Product')
}

/** The rating the product page shows: its Product JSON-LD's aggregateRating and its review list's summary words. */
async function productPageRating(page: Page) {
  const ld = await productJsonLd(page)
  return {
    products: ld.length,
    aggregateRating: ld[0]?.aggregateRating ?? 'none',
    summaries: (await page.locator('nymbal-review-list [part~="summary"]').allTextContents()).map(
      words,
    ),
  }
}

/**
 * Reads `path` until `read` answers `want` (a cached page is reloaded), with JavaScript off (the server's HTML), then
 * with JavaScript on once every element has upgraded.
 */
async function shownOnBoth<T>(
  browser: Browser,
  testInfo: TestInfo,
  page: Page,
  path: string,
  read: (page: Page) => Promise<T>,
  want: T,
  /** The element whose upgrade the JavaScript-on read waits for. */
  tag: string,
): Promise<void> {
  const off = await noScript(browser, testInfo)
  try {
    const plain = await off.newPage()
    await blockExternalRequests(plain)
    await expect
      .poll(
        async () => {
          const res = await plain.goto(path)
          expect(res?.status(), `GET ${path}`).toBe(200)
          return read(plain)
        },
        { ...RELOADED, message: `${path} with JavaScript off` },
      )
      .toEqual(want)
  } finally {
    await off.close()
  }

  await expect
    .poll(
      async () => {
        await page.goto(path)
        await upgradedAll(page, tag)
        return read(page)
      },
      { ...RELOADED, message: `${path} once upgraded` },
    )
    .toEqual(want)
}

test.describe('Ratings where shoppers choose', () => {
  // Kills: no rating on a card, in search results or on the product page; a rating for a product with only pending or
  // rejected reviews; a pending review counted; a client render that drops what the server rendered.
  test('AC-7: A with approved 5 and 4 and a pending 1 shows 4.5 and (2) on its card in /products and /search?q=<term>, server-rendered and upgraded, and its page has aggregateRating 4.5 from 2 and the summary "4.5 out of 5 · 2 reviews"; B with a pending and a rejected review shows no rating anywhere', async ({
    browser,
    page,
    request,
  }, testInfo) => {
    test.setTimeout(420_000)
    await blockExternalRequests(page)
    const token = await adminToken(request)
    const term = `rated${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const products = {
      A: await productOf(request, token, term, 'A', 1),
      B: await productOf(request, token, term, 'B', 2),
    }
    const [first, second, third] = [
      await shopperToken(request),
      await shopperToken(request),
      await shopperToken(request),
    ]
    await moderate(request, token, await reviewed(request, first, products.A.id, 5), 'approved')
    await moderate(request, token, await reviewed(request, second, products.A.id, 4), 'approved')
    await reviewed(request, third, products.A.id, 1)
    await reviewed(request, first, products.B.id, 2)
    await moderate(request, token, await reviewed(request, second, products.B.id, 3), 'rejected')

    // The pages show the rating the API serves: A's is the mean of its approved 5 and 4 over those two, B's none.
    const served = await Promise.all(
      [products.A, products.B].map(async (p) => {
        const res = await request.get(`${API_URL}/api/products/${p.slug}`)
        return ((await res.json()) as { data: { rating: unknown } }).data.rating
      }),
    )
    expect(served).toEqual([{ average: (5 + 4) / 2, count: 2 }, null])

    const cards = { A: { cards: 1, ratings: ['4.5 (2)'] }, B: { cards: 1, ratings: [] } }
    for (const path of ['/products?sort=price-asc', `/search?q=${term}`]) {
      await shownOnBoth(
        browser,
        testInfo,
        page,
        path,
        (p) => cardsOf(p, products),
        cards,
        'nymbal-product-card',
      )
    }

    await shownOnBoth(
      browser,
      testInfo,
      page,
      `/product/${products.A.slug}`,
      productPageRating,
      {
        products: 1,
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: 4.5,
          reviewCount: 2,
          bestRating: 5,
          worstRating: 1,
        },
        summaries: ['4.5 out of 5 · 2 reviews'],
      },
      'nymbal-review-list',
    )
    await shownOnBoth(
      browser,
      testInfo,
      page,
      `/product/${products.B.slug}`,
      productPageRating,
      { products: 1, aggregateRating: 'none', summaries: [] },
      'nymbal-review-list',
    )
  })
})
