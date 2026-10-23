import type { BrowserContext, Locator, Page } from '@playwright/test'
import { seedProducts } from '../../../packages/platform/src/seed/data'
import { storeCapabilities } from '../support/capabilities'
import { adminToken, ownProduct } from '../support/checkout'
import { API_URL } from '../support/csrf'
import {
  apiPage,
  cardSlugs,
  catalogProduct,
  expectMarkupReused,
  isNext,
  markWindow,
  windowMarked,
  type CatalogProduct,
} from '../support/elements'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { noScript, upgraded } from '../support/server-rendered'
import { formatPrice, specStockLevel } from '../support/variants'

// P2-17 AC-3, store end state browse.grid-is-element, on production builds of both templates
// (playwright.prod.config.ts); the JS-off contexts are made from a JS-on context's storage state.
// With JavaScript off: `/` shows the featured grid's `nymbal-product-card`s inside `nymbal-product-grid`, the first
// four images eager and the rest lazy; `/products` and `/category/<slug>` show their grids in the API's order, with
// `load-more` exactly when `GET /api/products` has a `nextCursor`; a product page shows `nymbal-product-price` and
// `nymbal-stock-badge` for its first variant (the badge's `data-level` the spec's rule), `nymbal-breadcrumb` with the
// product as `aria-current="page"`, `nymbal-image-gallery`'s main image and one thumbnail per image, and the related
// `nymbal-product-grid`. With JavaScript on: the same pages reuse the markup (per-part counts equal, no template left,
// no console error); a sort on the listing re-renders the grid from the store in the order the store's
// `GET /api/products?sort=<key>` answered, in the same document; `load-more` appends the page
// `GET /api/products?cursor=…` answered; the PDP's price and badge follow a variant click and a thumbnail click swaps
// the main image; on Next the home → listing → PDP clicks are soft navigations that hold the same.
// Kills: a page still rendering template markup for a grid or the PDP; a grid empty without JS; a sort that leaves
// the server's cards or duplicates them, or reloads the page; a lazy first card; a card click that is a full load on Next.

const PRODUCT = seedProducts[0]!.slug
const PAGE_SIZE = 24

const contexts: BrowserContext[] = []

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close()
})

/** A JS-off context with the JS-on context's storage state, and a page on `path` in it. */
async function scriptOff(
  browser: Parameters<typeof noScript>[0],
  testInfo: Parameters<typeof noScript>[1],
  from: BrowserContext,
  path: string,
): Promise<Page> {
  const off = await noScript(browser, testInfo, from)
  contexts.push(off)
  const page = await off.newPage()
  await blockExternalRequests(page)
  const response = await page.goto(path)
  expect(response?.status(), `GET ${path}`).toBe(200)
  return page
}

/**
 * The seeded category with the most products, and its first page as the API serves it with the default sort. With
 * `fixed`, the first category is passed over: `catalogProduct` adds its products there, so it grows while tests run.
 */
async function largestCategory(
  request: Parameters<typeof apiPage>[0],
  sort: string,
  fixed = false,
): Promise<{ slug: string; size: number }> {
  const res = await request.get(`${API_URL}/api/categories`)
  expect(res.status(), 'GET /api/categories').toBe(200)
  const all = ((await res.json()) as { data: Array<{ slug: string }> }).data
  let chosen = { slug: '', size: 0 }
  for (const { slug } of fixed ? all.slice(1) : all) {
    const size = (await apiPage(request, { category: slug, limit: String(PAGE_SIZE), sort })).items
      .length
    if (size > chosen.size) chosen = { slug, size }
  }
  expect(chosen.size, 'a seeded category with products').toBeGreaterThan(1)
  return chosen
}

/** The PDP's product: two sizes of different price and stock level, and three images. */
function pdpProduct(request: Parameters<typeof catalogProduct>[0]): Promise<CatalogProduct> {
  return catalogProduct(
    request,
    [
      { size: 'S', priceMinor: 1500, stock: 2 },
      { size: 'M', priceMinor: 2700, stock: 12 },
    ],
    3,
  )
}

/** The `<img>` the gallery's `main` part shows (the part itself, or the image inside it): its `src` and `fetchpriority`. */
async function mainImage(page: Page): Promise<{ src: string | null; priority: string | null }> {
  return page.locator('nymbal-image-gallery').evaluate((gallery) => {
    const main = gallery.shadowRoot?.querySelector('[part~="main"]')
    const img = main?.localName === 'img' ? main : main?.querySelector('img')
    return {
      src: img?.getAttribute('src') ?? null,
      priority: img?.getAttribute('fetchpriority') ?? null,
    }
  })
}

async function mainImageSrc(page: Page): Promise<string | null> {
  return (await mainImage(page)).src
}

/** Each card image of a grid, in card order: its `src`, `loading` and `fetchpriority`. */
async function cardImages(
  grid: Locator,
): Promise<Array<{ src: string | null; loading: string | null; priority: string | null }>> {
  return grid.locator('nymbal-product-card').evaluateAll((cards) =>
    cards.map((card) => {
      const img = card.shadowRoot?.querySelector('[part~="image"]')
      return {
        src: img?.getAttribute('src') ?? null,
        loading: img?.getAttribute('loading') ?? null,
        priority: img?.getAttribute('fetchpriority') ?? null,
      }
    }),
  )
}

/** The `href` of every `<link rel="preload" as="image">` in the parsed head, in order. */
async function headImagePreloads(page: Page): Promise<Array<string | null>> {
  return page
    .locator('head link[rel="preload"][as="image"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
}

/**
 * Every `<img fetchpriority="high">` on the page, light DOM and every open shadow root: its `src`, and whether it is the
 * gallery's `main` image.
 */
async function highPriorityImages(
  page: Page,
): Promise<Array<{ src: string | null; main: boolean }>> {
  return page.evaluate(() => {
    const all: Element[] = []
    const walk = (root: Document | ShadowRoot): void => {
      for (const el of root.querySelectorAll('*')) {
        all.push(el)
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    const part = all
      .find((el) => el.localName === 'nymbal-image-gallery')
      ?.shadowRoot?.querySelector('[part~="main"]')
    const main = part?.localName === 'img' ? part : part?.querySelector('img')
    return all
      .filter((el) => el.localName === 'img' && el.getAttribute('fetchpriority') === 'high')
      .map((img) => ({ src: img.getAttribute('src'), main: img === main }))
  })
}

test.describe('P2-17 AC-3: the grids and the PDP are elements (production build)', () => {
  test('AC-3: browse.grid-is-element: with JS off, / shows the featured grid’s nymbal-product-cards inside nymbal-product-grid, the first four images eager with high priority and the rest lazy, and the head preloads the first card’s image', async ({
    browser,
    context,
    request,
  }, testInfo) => {
    const page = await scriptOff(browser, testInfo, context, '/')
    const grids = page.locator('main nymbal-product-grid')
    await expect(grids).toHaveCount(1)
    const slugs = await cardSlugs(grids)
    const featured = await apiPage(request, { limit: '8' })
    expect(slugs.length, 'featured cards').toBe(featured.items.length)
    expect(slugs.length).toBeGreaterThan(4)
    expect(new Set(slugs).size).toBe(slugs.length)

    const images = await cardImages(grids)
    expect(images.map(({ loading, priority }) => ({ loading, high: priority === 'high' }))).toEqual(
      slugs.map((_, i) => ({ loading: i < 4 ? 'eager' : 'lazy', high: i < 4 })),
    )
    // Decision 9: the preload scanner never reaches an image inside a declarative shadow root, so the head starts it.
    expect(images[0]?.src, 'the first card has an image').toBeTruthy()
    expect(
      await headImagePreloads(page),
      'head image preloads: the first card’s image only',
    ).toEqual([images[0]!.src])
  })

  test('AC-3: browse.grid-is-element: with JS off, /products and /category/<slug> show their grids in the API’s order, with load-more exactly when GET /api/products has a nextCursor, the first four images eager and the rest lazy, and the head preloads the first card’s image', async ({
    browser,
    context,
    request,
  }, testInfo) => {
    // More than a page of products, so the listing has a next page (products are only ever added).
    await ownProduct(request, await adminToken(request), 5)
    const { defaultSort: sort } = (await storeCapabilities(request)).catalog
    const category = await largestCategory(request, sort)

    for (const [path, query] of [
      ['/products', { limit: String(PAGE_SIZE), sort }],
      [`/category/${category.slug}`, { limit: String(PAGE_SIZE), sort, category: category.slug }],
    ] as const) {
      // Other journeys add products while this runs: read the API and the page until both are of one moment.
      let page: Page | undefined
      await expect(async () => {
        const api = await apiPage(request, query)
        page = await scriptOff(browser, testInfo, context, path)
        const grid = page.locator('nymbal-product-grid')
        await expect(grid, `${path}: one grid`).toHaveCount(1)
        expect(await cardSlugs(grid), `${path}: the API's order`).toEqual(
          api.items.map((p) => p.slug),
        )
        const shown = await grid.locator('[part~="load-more"]').filter({ visible: true }).count()
        expect(shown, `${path}: load-more with nextCursor ${api.nextCursor}`).toBe(
          api.nextCursor === null ? 0 : 1,
        )
      }).toPass({ timeout: 30_000 })

      // Read once the page is settled, outside the retry, so a missing preload fails at once.
      const images = await cardImages(page!.locator('nymbal-product-grid'))
      expect(images.length, `${path}: cards`).toBeGreaterThan(0)
      expect
        .soft(
          images.map(({ loading, priority }) => ({ loading, high: priority === 'high' })),
          `${path}: the first four images eager with high priority, the rest lazy`,
        )
        .toEqual(images.map((_, i) => ({ loading: i < 4 ? 'eager' : 'lazy', high: i < 4 })))
      expect(images[0]?.src, `${path}: the first card has an image`).toBeTruthy()
      expect
        .soft(
          await headImagePreloads(page!),
          `${path}: head image preloads: the first card’s image only`,
        )
        .toEqual([images[0]!.src])
    }
    expect((await apiPage(request, { limit: String(PAGE_SIZE), sort })).nextCursor).not.toBeNull()
    expect(
      (await apiPage(request, { limit: String(PAGE_SIZE), sort, category: category.slug }))
        .nextCursor,
      'the category fits one page',
    ).toBeNull()
  })

  test('AC-3: browse.grid-is-element: with JS off, the PDP shows nymbal-product-price and nymbal-stock-badge for the first variant, nymbal-breadcrumb with the product as aria-current, the gallery’s main image and a thumbnail per image, and the related nymbal-product-grid; the main image is the page’s only fetchpriority="high" image and the head’s only image preload, every related card image lazy', async ({
    browser,
    context,
    request,
  }, testInfo) => {
    const product = await pdpProduct(request)
    const first = product.variants[0]!
    const page = await scriptOff(browser, testInfo, context, `/product/${product.slug}`)
    const main = page.locator('main')

    await expect(main.locator('nymbal-product-price').getByTestId('product-price')).toHaveText(
      formatPrice(first.priceMinor, product.currency),
    )
    await expect(main.locator('nymbal-stock-badge').getByTestId('stock-badge')).toHaveAttribute(
      'data-level',
      specStockLevel(first.stock),
    )
    const current = main.locator('nymbal-breadcrumb').locator('[aria-current="page"]')
    await expect(current).toHaveCount(1)
    await expect(current).toHaveText(product.name)
    await expect(main.locator('nymbal-breadcrumb').getByTestId('breadcrumb')).toHaveCount(1)

    expect(await mainImageSrc(page)).toBe(product.images[0])
    const thumbnails = main.locator('nymbal-image-gallery').locator('[part~="thumbnail"]')
    await expect(thumbnails).toHaveCount(product.images.length)

    const related = await cardSlugs(main.locator('nymbal-product-grid'))
    expect(related.length, 'related cards').toBeGreaterThan(0)
    expect(related.length).toBeLessThanOrEqual(4)
    expect(related, 'the product is not its own relation').not.toContain(product.slug)

    // Decision 9: the gallery's main image is the PDP's LCP; nothing below the fold outranks it.
    const gallery = await mainImage(page)
    expect.soft(gallery.priority, 'the gallery’s main image fetchpriority').toBe('high')
    expect
      .soft(
        await highPriorityImages(page),
        'the page’s fetchpriority="high" images: the gallery’s main one only',
      )
      .toEqual([{ src: gallery.src, main: true }])
    const relatedImages = await cardImages(main.locator('nymbal-product-grid'))
    expect(relatedImages.length, 'a related card image per related card').toBe(related.length)
    expect
      .soft(
        relatedImages.map(({ loading, priority }) => ({ loading, priority })),
        'every related card image lazy, with no fetchpriority',
      )
      .toEqual(relatedImages.map(() => ({ loading: 'lazy', priority: null })))
    expect
      .soft(await headImagePreloads(page), 'head image preloads: the gallery’s main image only')
      .toEqual([gallery.src])
  })

  for (const [name, path] of [
    ['home', '/'],
    ['listing', '/products'],
    ['category', 'category'],
    ['product', `/product/${PRODUCT}`],
  ] as const) {
    test(`AC-3: browse.grid-is-element: ${name}: with JS on every element the server rendered keeps its part counts, no shadowrootmode template is left and the console has no error`, async ({
      page,
      browser,
      request,
    }, testInfo) => {
      await blockExternalRequests(page)
      // Other workers add products between the JS-off and the JS-on read. The listing starts over a page, so its
      // nextCursor (and load-more) holds for both; the category is one no other test adds to.
      if (name === 'listing') await ownProduct(request, await adminToken(request), 1)
      const { defaultSort } = (await storeCapabilities(request)).catalog
      const at =
        path === 'category'
          ? `/category/${(await largestCategory(request, defaultSort, true)).slug}`
          : path
      const elements =
        name === 'product'
          ? [
              'nymbal-product-price',
              'nymbal-stock-badge',
              'nymbal-breadcrumb',
              'nymbal-image-gallery',
              'nymbal-product-grid',
            ]
          : // The cards are inside the grid's shadow root; the light-DOM host is the grid.
            ['nymbal-product-grid']
      await expectMarkupReused(page, browser, testInfo, at, elements)
    })
  }

  test('AC-3: browse.sort: with JS on, a sort on /products re-renders the grid from the store in the order GET /api/products?sort=<key> answered it, without reloading the page', async ({
    page,
  }) => {
    await blockExternalRequests(page)
    await page.goto('/products', { waitUntil: 'load' })
    await upgraded(page, ['nymbal-product-grid', 'nymbal-sort-dropdown'])
    await markWindow(page)
    const before = await cardSlugs(page.locator('nymbal-product-grid'))
    expect(before.length).toBeGreaterThan(1)

    const sorted = page.waitForResponse((r) => {
      const url = new URL(r.url())
      return (
        r.request().method() === 'GET' &&
        url.pathname === '/api/products' &&
        url.searchParams.get('sort') === 'price-desc' &&
        !url.searchParams.has('cursor')
      )
    })
    await page.getByTestId('sort-dropdown').selectOption('price-desc')
    const answer = (await (await sorted).json()) as { data: { items: Array<{ slug: string }> } }
    const order = answer.data.items.map((p) => p.slug)
    expect(order.length).toBeGreaterThan(1)

    await expect
      .poll(() => cardSlugs(page.locator('nymbal-product-grid')), { timeout: 10_000 })
      .toEqual(order)
    expect(await windowMarked(page), 'the sort re-rendered in place, without a page load').toBe(
      true,
    )
  })

  test('AC-3: browse.grid-is-element: with JS on, load-more on /products appends the page GET /api/products?cursor=… answered to the store’s first page', async ({
    page,
    request,
  }) => {
    await ownProduct(request, await adminToken(request), 5)
    await blockExternalRequests(page)
    const isList = (cursor: boolean) => (r: { url(): string; request(): { method(): string } }) => {
      const url = new URL(r.url())
      return (
        r.request().method() === 'GET' &&
        url.pathname === '/api/products' &&
        url.searchParams.has('cursor') === cursor
      )
    }
    const firstLoad = page.waitForResponse(isList(false))
    await page.goto('/products', { waitUntil: 'load' })
    await upgraded(page, ['nymbal-product-grid'])
    const first = ((await (await firstLoad).json()) as { data: { items: Array<{ slug: string }> } })
      .data.items
    const grid = page.locator('nymbal-product-grid')
    await expect.poll(() => cardSlugs(grid), { timeout: 10_000 }).toEqual(first.map((p) => p.slug))

    const nextPage = page.waitForResponse(isList(true))
    await grid.locator('[part~="load-more"]').filter({ visible: true }).click()
    const more = ((await (await nextPage).json()) as { data: { items: Array<{ slug: string }> } })
      .data.items
    expect(more.length, 'the cursor page has products').toBeGreaterThan(0)
    await expect
      .poll(() => cardSlugs(grid), { timeout: 10_000 })
      .toEqual([...first, ...more].map((p) => p.slug))
  })

  test('AC-3: browse.variant-shape: with JS on, the PDP’s nymbal-product-price and nymbal-stock-badge follow a variant click, and a thumbnail click swaps the gallery’s main image', async ({
    page,
    request,
  }) => {
    const product = await pdpProduct(request)
    await blockExternalRequests(page)
    await page.goto(`/product/${product.slug}`, { waitUntil: 'load' })
    await upgraded(page, [
      'nymbal-product-price',
      'nymbal-stock-badge',
      'nymbal-variant-selector',
      'nymbal-image-gallery',
    ])
    const main = page.locator('main')
    const price = main.locator('nymbal-product-price').getByTestId('product-price')
    const badge = main.locator('nymbal-stock-badge').getByTestId('stock-badge')

    for (const variant of [...product.variants.slice(1), product.variants[0]!]) {
      for (const o of variant.options) {
        await main.getByTestId(`variant-option-${o.name}-${o.value}`).click()
      }
      await expect(price).toHaveText(formatPrice(variant.priceMinor, product.currency))
      await expect(badge).toHaveAttribute('data-level', specStockLevel(variant.stock))
    }

    const thumbnails = main.locator('nymbal-image-gallery').locator('[part~="thumbnail"]')
    await expect(thumbnails).toHaveCount(product.images.length)
    for (const i of [2, 1]) {
      await thumbnails.nth(i).click()
      await expect.poll(() => mainImageSrc(page)).toBe(product.images[i])
    }
  })

  test('AC-3: browse.grid-is-element: on Next, / → the header’s listing link → a card are soft navigations, and the listing grid and the PDP’s price and badge are the elements, holding the API’s data @nextjs', async ({
    page,
    request,
  }, testInfo) => {
    expect(isNext(testInfo)).toBe(true)
    await blockExternalRequests(page)
    await page.goto('/', { waitUntil: 'load' })
    await upgraded(page, ['nymbal-site-header', 'nymbal-product-grid'])
    await markWindow(page)

    await page
      .locator('nymbal-site-header [part~="link"][href="/products"]')
      .filter({ visible: true })
      .first()
      .click()
    await page.waitForURL((url) => url.pathname === '/products')
    expect(await windowMarked(page), '/products reached without a full load').toBe(true)
    const grid = page.locator('nymbal-product-grid')
    await upgraded(page, ['nymbal-product-grid'])
    const slugs = await cardSlugs(grid)
    expect(slugs.length).toBeGreaterThan(0)

    await grid.locator('nymbal-product-card').first().locator('[part~="card"]').click()
    await page.waitForURL((url) => url.pathname === `/product/${slugs[0]}`)
    expect(await windowMarked(page), 'the PDP reached without a full load').toBe(true)

    const res = await request.get(`${API_URL}/api/products/${slugs[0]}`)
    const product = (
      (await res.json()) as {
        data: { currency: string; variants: Array<{ priceMinor: number; stock: number }> }
      }
    ).data
    await upgraded(page, ['nymbal-product-price', 'nymbal-stock-badge'])
    await expect(page.locator('nymbal-product-price').getByTestId('product-price')).toHaveText(
      formatPrice(product.variants[0]!.priceMinor, product.currency),
    )
    await expect(page.locator('nymbal-stock-badge').getByTestId('stock-badge')).toHaveAttribute(
      'data-level',
      specStockLevel(product.variants[0]!.stock),
    )
  })
})
