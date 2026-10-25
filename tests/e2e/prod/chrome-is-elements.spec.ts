import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import { seedProducts } from '../../../packages/platform/src/seed/data'
import {
  adminToken,
  openCheckout,
  orderNumberOf,
  ownProduct,
  walkToPayment,
} from '../support/checkout'
import { API_URL } from '../support/csrf'
import { expectMarkupReused, isNext } from '../support/elements'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { noScript, upgraded } from '../support/server-rendered'
import { formatPrice } from '../support/variants'

// AC-4, on production builds of both templates (playwright.prod.config.ts); the override clause is
// tests/e2e/journeys/footer-override.spec.ts on the `*-override` targets. With JavaScript off: `/` shows
// `nymbal-site-header` with its nav links, its account link and the page's `nymbal-search-bar` and `nymbal-mini-cart`
// as light-DOM children assigned to its `search` and `cart` slots, each rendered by the server; `nymbal-site-footer`'s
// columns; `nymbal-category-nav`'s cards, one per category of `GET /api/categories`; a product page shows
// `nymbal-review-list` (its reviews, or its empty state when the API has none) and `nymbal-review-form`;
// `/order/<n>`, for an order placed through the checkout with JS on in the same context and read JS off from its
// storage state, shows `nymbal-order-summary`'s lines, subtotal, discount (when non-zero), shipping, tax and total
// equal to `GET /api/orders/:n`, which sum per the invariant. With JavaScript on the same pages reuse the markup
// (per-part counts equal, no template left, no console error); the header's search suggestion opens the product and
// its mini-cart opens the drawer; the footer's `link` part is painted with a `--nymbal-color-*` token, the colour the
// template's own tokens file gives it.

const PRODUCT = seedProducts[0]!.slug
const REPO = new URL('../../../', import.meta.url)

const contexts: BrowserContext[] = []

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close()
})

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

interface ApiOrder {
  orderNumber: string
  lineItems: Array<{
    productName: string
    qty: number
    unitPriceMinor: number
    lineTotalMinor: number
  }>
  subtotalMinor: number
  discountTotalMinor: number
  shippingTotalMinor: number
  taxTotalMinor: number
  totalMinor: number
  currency: string
}

/** The text of each node in `host`'s shadow root carrying exactly this part token, whitespace collapsed. */
function partTexts(page: Page, host: string, part: string): Promise<string[]> {
  return page
    .locator(host)
    .first()
    .evaluate(
      (el, p) =>
        Array.from(el.shadowRoot?.querySelectorAll('[part]') ?? [])
          .filter((n) => (n.getAttribute('part') ?? '').split(/\s+/).includes(p))
          .map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim()),
      part,
    )
}

test.describe('AC-4: the chrome is elements (production build)', () => {
  test('AC-4: theming.chrome-is-elements: with JS off, / shows nymbal-site-header with nav links, the account link and the search bar and mini-cart in its search and cart slots, nymbal-site-footer’s columns and nymbal-category-nav’s card per category; with JS on the markup is reused', async ({
    browser,
    context,
    page,
    request,
  }, testInfo) => {
    const off = await scriptOff(browser, testInfo, context, '/')
    const header = off.locator('nymbal-site-header')
    await expect(header).toHaveCount(1)
    await expect(header.getByTestId('site-header')).toHaveCount(1)
    const hrefs = await header
      .locator('[part~="link"]')
      .evaluateAll((links) => links.map((l) => l.getAttribute('href') ?? ''))
    expect(hrefs.length, 'header nav links').toBeGreaterThan(0)
    expect(
      hrefs.filter((h) => !h.startsWith('/')),
      'nav links within the store',
    ).toEqual([])
    await expect(header.locator('[part~="account"]').first()).toHaveAttribute('href', /\/account/)

    const slotted = await header.evaluate((host) =>
      Array.from(host.children)
        .filter((c) => c.localName === 'nymbal-search-bar' || c.localName === 'nymbal-mini-cart')
        .map((c) => ({
          tag: c.localName,
          slot: c.getAttribute('slot'),
          assigned: c.assignedSlot?.getAttribute('name') ?? null,
          rendered: c.shadowRoot !== null,
        })),
    )
    expect(slotted).toEqual([
      { tag: 'nymbal-search-bar', slot: 'search', assigned: 'search', rendered: true },
      { tag: 'nymbal-mini-cart', slot: 'cart', assigned: 'cart', rendered: true },
    ])

    const footer = off.locator('nymbal-site-footer')
    await expect(footer).toHaveCount(1)
    await expect(footer.getByTestId('site-footer')).toHaveCount(1)
    const columns = await footer.locator('[part~="column"]').count()
    expect(columns, 'footer columns').toBeGreaterThan(0)
    expect(await footer.locator('[part~="heading"]').count()).toBe(columns)
    expect(await footer.locator('[part~="link"]').count()).toBeGreaterThanOrEqual(columns)

    const res = await request.get(`${API_URL}/api/categories`)
    expect(res.status()).toBe(200)
    const categories = ((await res.json()) as { data: Array<{ slug: string }> }).data
    expect(categories.length).toBeGreaterThan(0)
    const cards = await off
      .locator('nymbal-category-nav [part~="card"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    expect(cards).toEqual(categories.map((c) => `category-${c.slug}`))

    await blockExternalRequests(page)
    await expectMarkupReused(page, browser, testInfo, '/', [
      'nymbal-site-header',
      'nymbal-site-footer',
      'nymbal-category-nav',
      'nymbal-search-bar',
      'nymbal-mini-cart',
    ])
  })

  test('AC-4: theming.chrome-is-elements: with JS off, a product page shows nymbal-review-list (the API’s reviews, or its empty state) and nymbal-review-form’s fields and submit; with JS on the markup is reused', async ({
    browser,
    context,
    page,
    request,
  }, testInfo) => {
    const productRes = await request.get(`${API_URL}/api/products/${PRODUCT}`)
    const productId = ((await productRes.json()) as { data: { id: string } }).data.id
    const reviewsRes = await request.get(`${API_URL}/api/products/${productId}/reviews`)
    expect(reviewsRes.status()).toBe(200)
    const reviews = ((await reviewsRes.json()) as { data: { items: Array<{ id: string }> } }).data
      .items

    const off = await scriptOff(browser, testInfo, context, `/product/${PRODUCT}`)
    const list = off.locator('main nymbal-review-list')
    await expect(list).toHaveCount(1)
    const shown = await list
      .locator('[part~="review"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    expect(shown).toEqual(reviews.map((r) => `review-${r.id}`))
    await expect(list.locator('[part~="empty"]')).toHaveCount(reviews.length === 0 ? 1 : 0)

    const form = off.locator('main nymbal-review-form')
    await expect(form).toHaveCount(1)
    for (const [part, id] of [
      ['form', 'review-form'],
      ['rating', 'review-rating'],
      ['title', 'review-title'],
      ['body', 'review-body'],
      ['submit', 'review-submit'],
    ] as const) {
      await expect(form.locator(`[part~="${part}"][data-testid="${id}"]`), part).toHaveCount(1)
    }

    await blockExternalRequests(page)
    await expectMarkupReused(page, browser, testInfo, `/product/${PRODUCT}`, [
      'nymbal-review-list',
      'nymbal-review-form',
    ])
  })

  test('AC-4: theming.chrome-is-elements: an order placed through the checkout with JS on, read with JS off from its storage state: nymbal-order-summary’s lines, subtotal, discount when non-zero, shipping, tax and total are GET /api/orders/:n’s and sum per the invariant; with JS on the markup is reused', async ({
    browser,
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    await blockExternalRequests(page)
    const product = await ownProduct(request, await adminToken(request), 5)
    await openCheckout(page, product)
    await walkToPayment(page, `e2e-elements-${randomUUID().slice(0, 8)}@e2e.test`)
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const orderNumber = orderNumberOf(page)
    const res = await page.request.get(`${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`)
    expect(res.status(), `GET /api/orders/${orderNumber}`).toBe(200)
    const order = ((await res.json()) as { data: ApiOrder }).data
    const money = (minor: number): string => formatPrice(minor, order.currency)

    // The order's own money holds the invariant the summary shows.
    expect(order.lineItems.reduce((n, l) => n + l.lineTotalMinor, 0)).toBe(order.subtotalMinor)
    expect(
      order.subtotalMinor -
        order.discountTotalMinor +
        order.shippingTotalMinor +
        order.taxTotalMinor,
    ).toBe(order.totalMinor)

    const off = await scriptOff(browser, testInfo, page.context(), `/order/${orderNumber}`)
    const host = 'nymbal-order-summary'
    await expect(off.locator(host)).toHaveCount(1)
    await expect(off.locator(host).getByTestId('order-summary')).toHaveCount(1)
    const lines = await partTexts(off, host, 'line')
    expect(lines.length, 'one line per order line').toBe(order.lineItems.length)
    order.lineItems.forEach((item, i) => {
      expect(lines[i], `line ${i}`).toContain(item.productName)
      expect(lines[i], `line ${i}`).toContain(String(item.qty))
      expect(lines[i], `line ${i}`).toContain(money(item.lineTotalMinor))
    })
    const totals = (await partTexts(off, host, 'totals')).join(' ')
    expect(totals).toContain(money(order.subtotalMinor))
    expect(totals).toContain(money(order.taxTotalMinor))
    expect(
      order.shippingTotalMinor === 0
        ? totals.includes(money(0)) || /free/i.test(totals)
        : totals.includes(money(order.shippingTotalMinor)),
      `shipping ${order.shippingTotalMinor} in "${totals}"`,
    ).toBe(true)
    const discount = await partTexts(off, host, 'discount')
    expect(discount.length).toBe(order.discountTotalMinor > 0 ? 1 : 0)
    if (order.discountTotalMinor > 0) expect(discount[0]).toContain(money(order.discountTotalMinor))
    expect((await partTexts(off, host, 'total')).join(' ')).toContain(money(order.totalMinor))

    await expectMarkupReused(page, browser, testInfo, `/order/${orderNumber}`, [
      'nymbal-order-summary',
      'nymbal-site-header',
    ])
  })

  test('AC-4: theming.chrome-is-elements: with JS on, the header’s search suggestion opens that product and its mini-cart opens the cart drawer', async ({
    page,
    request,
  }) => {
    await blockExternalRequests(page)
    const found = await request.get(`${API_URL}/api/products/search?q=wool&limit=1`)
    expect(found.status()).toBe(200)
    const seeded = ((await found.json()) as { data: { items: Array<{ name: string }> } }).data
      .items[0]
    expect(seeded, 'a seeded product matching "wool"').toBeDefined()

    await page.goto('/', { waitUntil: 'load' })
    await upgraded(page, ['nymbal-site-header', 'nymbal-search-bar', 'nymbal-mini-cart'])
    const header = page.locator('nymbal-site-header')
    await header
      .locator('nymbal-mini-cart')
      .getByTestId('mini-cart')
      .filter({ visible: true })
      .first()
      .click()
    await expect(page.getByTestId('cart-drawer')).toBeVisible({ timeout: 10_000 })

    await page.goto('/', { waitUntil: 'load' })
    await upgraded(page, ['nymbal-site-header', 'nymbal-search-bar'])
    const input = header
      .locator('nymbal-search-bar')
      .getByTestId('search-input')
      .filter({ visible: true })
      .first()
    await input.fill(seeded!.name)
    const suggestion = page.locator('[data-testid^="search-result-"]').first()
    await expect(suggestion).toHaveAttribute('data-slug', /\S/, { timeout: 15_000 })
    const slug = (await suggestion.getAttribute('data-slug'))!
    const chosen = await request.get(`${API_URL}/api/products/${encodeURIComponent(slug)}`)
    expect(chosen.status()).toBe(200)
    const name = ((await chosen.json()) as { data: { name: string } }).data.name

    await input.press('ArrowDown')
    await input.press('Enter')
    await page.waitForURL((url) => url.pathname === `/product/${slug}`, { timeout: 15_000 })
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  })

  test('AC-4: theming.tokens-apply: with JS on, nymbal-site-footer’s link part is painted with a --nymbal-color-* token, the colour the template’s own tokens file gives it', async ({
    page,
  }, testInfo) => {
    const file = fileURLToPath(
      new URL(
        isNext(testInfo)
          ? 'templates/nextjs/app/tokens.css'
          : 'templates/astro/src/styles/tokens.css',
        REPO,
      ),
    )
    const tokens = [
      ...new Set(
        [...readFileSync(file, 'utf8').matchAll(/(--nymbal-color-[a-z0-9-]+)\s*:/g)].map(
          (m) => m[1]!,
        ),
      ),
    ]
    expect(tokens.length, `${file} declares --nymbal-color-* tokens`).toBeGreaterThan(0)

    await blockExternalRequests(page)
    await page.goto('/', { waitUntil: 'load' })
    await upgraded(page, ['nymbal-site-footer'])
    const link = page.locator('nymbal-site-footer [part~="link"]').first()
    await expect(link).toBeAttached()

    // Each token's colour as :root resolves it from the template's file, and the link's colour now.
    const resolved = await page.evaluate((names) => {
      const probe = document.createElement('div')
      document.body.append(probe)
      const out: Record<string, string> = {}
      for (const name of names) {
        probe.style.color = ''
        probe.style.color = `var(${name})`
        out[name] = getComputedStyle(probe).color
      }
      probe.remove()
      return out
    }, tokens)
    const painted = await link.evaluate((el) => getComputedStyle(el).color)

    // Which token paints it: give every colour token a colour of its own and read the link again.
    const sentinel = (i: number): string => `rgb(${(i % 250) + 1}, ${Math.floor(i / 250) + 7}, 171)`
    await page.addStyleTag({
      content: `:root { ${tokens.map((t, i) => `${t}: ${sentinel(i)} !important;`).join(' ')} }`,
    })
    const repainted = await link.evaluate((el) => getComputedStyle(el).color)
    const index = tokens.findIndex((_, i) => sentinel(i) === repainted)
    expect(
      index,
      `the footer link (${repainted}) is painted by one of ${file}'s colour tokens`,
    ).toBeGreaterThanOrEqual(0)
    expect(painted, `${tokens[index]} as the tokens file resolves it`).toBe(
      resolved[tokens[index]!],
    )
  })
})

test.describe('AC-7: the order timeline is server-rendered (production build)', () => {
  // Kills: a guest page that renders the timeline in the browser only (no NymbalElement on Astro, no serverHtml on
  // Next), so with JavaScript off it holds no entries.
  test('AC-7: theming.server-rendered: with JS off, /order/<n> for an order placed and paid through the checkout holds nymbal-order-timeline’s entries in its declarative shadow root, equal in kind and datetime to GET /api/orders/:n’s timeline', async ({
    browser,
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    await blockExternalRequests(page)
    const product = await ownProduct(request, await adminToken(request), 5)
    await openCheckout(page, product)
    await walkToPayment(page, `e2e-timeline-${randomUUID().slice(0, 8)}@e2e.test`)
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const orderNumber = orderNumberOf(page)

    const off = await scriptOff(browser, testInfo, page.context(), `/order/${orderNumber}`)
    const host = off.locator('nymbal-order-timeline')
    await expect(host).toHaveCount(1)
    const shown = await host.evaluate((el) =>
      Array.from(el.shadowRoot?.querySelectorAll('[part]') ?? [])
        .filter((n) => (n.getAttribute('part') ?? '').split(/\s+/).includes('entry'))
        .map((li) => ({
          kind: li.getAttribute('data-kind') ?? '',
          at: li.querySelector('time')?.getAttribute('datetime') ?? '',
        })),
    )

    const res = await page.request.get(`${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`)
    expect(res.status(), `GET /api/orders/${orderNumber}`).toBe(200)
    const order = (
      (await res.json()) as {
        data: { status: string; timeline?: Array<{ kind: string; at: string }> }
      }
    ).data
    expect(order.status, 'placed and paid').toBe('confirmed')
    expect(shown, 'the server-rendered entries against the API’s timeline').toEqual(
      order.timeline ?? [],
    )
    expect(shown.map((e) => e.kind)).toEqual(['placed', 'paid'])
  })
})
