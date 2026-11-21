import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  test as withoutConsoleGuard,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { stackBlock } from '../../../scripts/stack'
import { linkTo, linksIn, mailbox, openAndPress } from '../support/alerts'
import { adminToken, ownProduct } from '../support/checkout'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { cartLines } from '../support/variants'

// A WordPress theme page: a real PHP site printing one script tag, two metas and Nymbal elements, on the kit loaded
// from the routed jsDelivr URL, against a store with its own Astro storefront. The cart is read back through the browser's
// own cookies, so a cookie that does not travel between the hosts fails here.

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const KIT_FILE = join(REPO, 'packages', 'web-components', 'dist', 'kit.js')
const KIT_URL = 'https://cdn.jsdelivr.net/npm/@nymbalhq/web-components@*/dist/kit.js'
const STORE_ORIGIN = `http://localhost:${stackBlock(Number(process.env.NYMBAL_STACK_SLOT ?? '0')).astroCustom}`
const TAGS = [
  'nymbal-add-to-cart',
  'nymbal-mini-cart',
  'nymbal-cart-drawer',
  'nymbal-quantity-selector',
  'nymbal-notify-me',
  'nymbal-toast',
]

interface Line {
  variantId: string
  qty: number
}

/** Serves the local build at the jsDelivr URL, with the headers jsDelivr answers. */
async function serveKit(page: Page): Promise<void> {
  if (!existsSync(KIT_FILE)) throw new Error(`${KIT_FILE} is missing: build the package first`)
  await page.route(KIT_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body: readFileSync(KIT_FILE),
    }),
  )
}

function wordpressOrigin(testInfo: TestInfo): string {
  const base = testInfo.project.use.baseURL
  if (base === undefined) throw new Error(`project ${testInfo.project.name} has no baseURL`)
  return new URL(base).origin
}

function themeUrl(origin: string, params: Record<string, string>): string {
  const url = new URL('/', origin)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return url.href
}

/** Goes to the page and waits for the kit's first cart read, which it sends only after the probe passes. */
async function openTheme(page: Page, url: string): Promise<void> {
  await serveKit(page)
  const firstRead = cartRead(page)
  await page.goto(url)
  expect((await firstRead).status(), 'the kit’s first GET /api/cart').toBe(200)
}

const cartRead = (page: Page) =>
  page.waitForResponse(
    (res) => new URL(res.url()).pathname === '/api/cart' && res.request().method() === 'GET',
  )

const pairs = (items: Line[]): Line[] => items.map(({ variantId, qty }) => ({ variantId, qty }))

/** `GET /api/cart` from the page itself, for hosts only the browser resolves: the cookie it holds, as it would send it. */
async function cartOnHost(page: Page, api: string): Promise<Line[]> {
  const items = await page.evaluate(async (apiUrl) => {
    const res = await fetch(`${apiUrl}/api/cart`, { credentials: 'include' })
    if (!res.ok) throw new Error(`GET /api/cart answered ${res.status}`)
    const body = (await res.json()) as { data: { items: Line[] } }
    return body.data.items
  }, api)
  return items.map(({ variantId, qty }) => ({ variantId, qty }))
}

const inStock = async (request: APIRequestContext, stock = 10) =>
  ownProduct(request, await adminToken(request), stock)

const address = (role: string): string =>
  `wordpress-kit-${role}-${randomUUID().slice(0, 8)}@nymbal.dev`

test('AC-16: Add to Cart on a WordPress page puts the variant in GET /api/cart at qty 1, the badge reads 1, and the drawer shows the line and is open @wordpress', async ({
  page,
  request,
}, testInfo) => {
  const product = await inStock(request)
  await openTheme(
    page,
    themeUrl(wordpressOrigin(testInfo), {
      api: API_URL,
      store: STORE_ORIGIN,
      variant: product.variantId,
    }),
  )

  await page.getByTestId('add-to-cart').click()

  await expect
    .poll(async () => pairs(await cartLines(page)))
    .toEqual([{ variantId: product.variantId, qty: 1 }])
  await expect(page.getByTestId('mini-cart-badge')).toHaveText('1')
  await expect(page.locator('nymbal-cart-drawer')).toHaveAttribute('open', '')
  await expect(page.getByTestId(`cart-item-${product.variantId}`)).toContainText('Qty: 1')
})

test('AC-17: stepping the quantity selector to 3 and adding gives qty 3 in GET /api/cart and a badge of 3 @wordpress', async ({
  page,
  request,
}, testInfo) => {
  const product = await inStock(request)
  await openTheme(
    page,
    themeUrl(wordpressOrigin(testInfo), {
      api: API_URL,
      store: STORE_ORIGIN,
      variant: product.variantId,
    }),
  )

  const increase = page.getByTestId('qty-increment')
  await increase.click()
  await increase.click()
  await expect(page.getByTestId('qty-input')).toHaveValue('3')
  await page.getByTestId('add-to-cart').click()

  await expect
    .poll(async () => pairs(await cartLines(page)))
    .toEqual([{ variantId: product.variantId, qty: 3 }])
  await expect(page.getByTestId('mini-cart-badge')).toHaveText('3')
})

test('AC-18: a reload shows the badge and the drawer lines GET /api/cart returns @wordpress', async ({
  page,
  request,
}, testInfo) => {
  const product = await inStock(request)
  const url = themeUrl(wordpressOrigin(testInfo), {
    api: API_URL,
    store: STORE_ORIGIN,
    variant: product.variantId,
  })
  await openTheme(page, url)
  await page.getByTestId('add-to-cart').click()
  await expect.poll(async () => pairs(await cartLines(page))).toHaveLength(1)
  const before = pairs(await cartLines(page))

  const reread = cartRead(page)
  await page.reload()
  expect((await reread).status()).toBe(200)

  const after = pairs(await cartLines(page))
  expect(after, 'the same cart, not a new one').toEqual(before)
  const units = after.reduce((sum, line) => sum + line.qty, 0)
  await expect(page.getByTestId('mini-cart-badge')).toHaveText(String(units))
  await page.getByTestId('mini-cart').click()
  await expect(page.getByTestId(/^cart-item-/)).toHaveCount(after.length)
  await expect(page.getByTestId(`cart-item-${product.variantId}`)).toContainText(
    `Qty: ${after[0]!.qty}`,
  )
})

test('AC-19: the drawer’s checkout opens the store’s /checkout, whose summary lists the line added on WordPress @wordpress', async ({
  page,
  request,
}, testInfo) => {
  const product = await inStock(request)
  await openTheme(
    page,
    themeUrl(wordpressOrigin(testInfo), {
      api: API_URL,
      store: STORE_ORIGIN,
      variant: product.variantId,
    }),
  )
  await page.getByTestId('add-to-cart').click()
  await expect(page.getByTestId(`cart-item-${product.variantId}`)).toBeVisible()

  await page.getByTestId('cart-checkout-btn').click()

  await expect(page).toHaveURL(`${STORE_ORIGIN}/checkout`)
  await expect(page.getByTestId('checkout-summary')).toContainText(product.name)
})

test('AC-20: with WordPress on www.nymbal-kit.test and the API on shop.nymbal-kit.test, an add gives the badge and GET /api/cart the same line @wordpress', async ({
  page,
  request,
}, testInfo) => {
  const product = await inStock(request)
  const wordpressPort = new URL(wordpressOrigin(testInfo)).port
  const apiOnSite = `http://shop.nymbal-kit.test:${new URL(API_URL).port}`
  await openTheme(
    page,
    themeUrl(`http://www.nymbal-kit.test:${wordpressPort}`, {
      api: apiOnSite,
      store: STORE_ORIGIN,
      variant: product.variantId,
    }),
  )

  await page.getByTestId('add-to-cart').click()

  await expect
    .poll(() => cartOnHost(page, apiOnSite))
    .toEqual([{ variantId: product.variantId, qty: 1 }])
  const units = (await cartOnHost(page, apiOnSite)).reduce((sum, line) => sum + line.qty, 0)
  await expect(page.getByTestId('mini-cart-badge')).toHaveText(String(units))
})

// This page logs the error on purpose, so it runs without the fixtures' guard against console errors.
withoutConsoleGuard(
  'AC-21: with the page on 127.0.0.1 and the API on localhost, the console holds the cross-site error naming both origins, none of the six tags is defined, and no /api/cart request is sent @wordpress',
  async ({ page, request }, testInfo) => {
    await serveKit(page)
    const product = await inStock(request)
    const pageOrigin = `http://127.0.0.1:${new URL(wordpressOrigin(testInfo)).port}`
    const apiOrigin = new URL(API_URL).origin
    const pageErrors: string[] = []
    const requests: URL[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('request', (req) => requests.push(new URL(req.url())))
    const refused = page.waitForEvent('console', {
      predicate: (msg) => msg.type() === 'error' && msg.text().includes('one registrable domain'),
    })

    await page.goto(
      themeUrl(pageOrigin, { api: API_URL, store: STORE_ORIGIN, variant: product.variantId }),
    )
    const message = (await refused).text()

    expect(message).toContain(pageOrigin)
    expect(message).toContain(apiOrigin)
    const defined = await page.evaluate(
      (tags) => tags.filter((tag) => customElements.get(tag) !== undefined),
      TAGS,
    )
    expect(defined).toEqual([])
    const toApi = requests.filter((url) => url.origin === apiOrigin)
    expect(toApi.map((url) => url.pathname)).toEqual(['/api/csrf', '/api/csrf'])
    expect(pageErrors).toEqual([])
  },
)

test('AC-22: with stock=0 a notify-me subscribe puts one confirmation in Mailpit whose every link, confirm and unsubscribe among them, begins with the store’s origin, and the confirm link’s press shows alert-confirmed @wordpress', async ({
  page,
  request,
}, testInfo) => {
  const product = await inStock(request, 0)
  const email = address('confirm')
  const mail = await mailbox()
  await openTheme(
    page,
    themeUrl(wordpressOrigin(testInfo), {
      api: API_URL,
      store: STORE_ORIGIN,
      variant: product.variantId,
      stock: '0',
    }),
  )

  await page.getByTestId('notify-me').locator('input[name="email"]').fill(email)
  await page.getByTestId('notify-me-submit').click()
  await expect(page.getByTestId('notify-me-notice')).toHaveText('Check your inbox to confirm.')

  const [confirmation] = await mail.waitFor(email, 1)
  const links = linksIn(confirmation!)
  expect(links.filter((url) => url.origin !== STORE_ORIGIN).map((url) => url.href)).toEqual([])
  const confirm = linkTo(confirmation!, '/alerts/confirm')
  const unsubscribe = linkTo(confirmation!, '/alerts/unsubscribe')
  expect([confirm.origin, unsubscribe.origin]).toEqual([STORE_ORIGIN, STORE_ORIGIN])

  await openAndPress(page, confirm.href)

  await expect(page.getByTestId('alert-confirmed')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`^${STORE_ORIGIN}/alerts/confirm`))
})

/**
 * Holds every POST to `url` until `release` runs; `posts` counts them. The second click of a double-click then lands
 * while the first request is on the wire, whatever the API's speed.
 */
async function holdPosts(
  page: Page,
  url: string,
): Promise<{ posts: () => number; release: () => void }> {
  let posts = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(url, async (route) => {
    if (route.request().method() === 'POST') {
      posts += 1
      await held
    }
    await route.continue()
  })
  return { posts: () => posts, release }
}

test('AC-23: double-clicking Add to Cart gives qty 1 in GET /api/cart from one POST @wordpress', async ({
  page,
  request,
}, testInfo) => {
  const product = await inStock(request)
  await openTheme(
    page,
    themeUrl(wordpressOrigin(testInfo), {
      api: API_URL,
      store: STORE_ORIGIN,
      variant: product.variantId,
    }),
  )
  const hold = await holdPosts(page, `${API_URL}/api/cart/items`)

  await page.getByTestId('add-to-cart').dblclick()
  await expect.poll(hold.posts).toBe(1)
  hold.release()

  await expect
    .poll(async () => pairs(await cartLines(page)))
    .toEqual([{ variantId: product.variantId, qty: 1 }])
  expect(hold.posts(), 'k rapid clicks, one command').toBe(1)
})

test('AC-23: double-clicking Notify me puts one confirmation in Mailpit from one POST @wordpress', async ({
  page,
  request,
}, testInfo) => {
  const product = await inStock(request, 0)
  const email = address('double')
  const mail = await mailbox()
  await openTheme(
    page,
    themeUrl(wordpressOrigin(testInfo), {
      api: API_URL,
      store: STORE_ORIGIN,
      variant: product.variantId,
      stock: '0',
    }),
  )
  const hold = await holdPosts(page, `${API_URL}/api/alerts/subscribe`)

  await page.getByTestId('notify-me').locator('input[name="email"]').fill(email)
  await page.getByTestId('notify-me-submit').dblclick()
  await expect.poll(hold.posts).toBe(1)
  hold.release()

  await expect(page.getByTestId('notify-me-notice')).toHaveText('Check your inbox to confirm.')
  await mail.waitFor(email, 1)
  expect(hold.posts(), 'k rapid clicks, one command').toBe(1)
  expect(await mail.messages(email)).toHaveLength(1)
})

test('a kit origin is refused CORS on the token refresh and an admin route, and answered with credentials on the cart @wordpress', async ({
  request,
}, testInfo) => {
  const origin = wordpressOrigin(testInfo)
  const headers = { origin }

  const refused = [
    await request.post(`${API_URL}/api/auth/refresh`, { headers }),
    await request.get(`${API_URL}/api/admin/customers`, { headers }),
  ]
  for (const res of refused) {
    expect(res.headers()['access-control-allow-origin'], res.url()).toBeUndefined()
    expect(res.headers()['access-control-allow-credentials'], res.url()).toBeUndefined()
  }

  const cart = await request.get(`${API_URL}/api/cart`, { headers })
  expect(cart.headers()['access-control-allow-origin']).toBe(origin)
  expect(cart.headers()['access-control-allow-credentials']).toBe('true')
})
