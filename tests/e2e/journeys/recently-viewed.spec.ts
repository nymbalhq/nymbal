import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from '@playwright/test'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { cardSlugs } from '../support/elements'
import { expect, test } from '../support/fixtures'

// Recently viewed on both templates (the astro and nextjs projects run this file), driven through the product only:
// product pages and `/` in the browser, the storefront's sign-in form and sign-out control, and the admin API. The
// list a page shows is the one `GET /api/recently-viewed` serves from the views its product pages captured: a guest's
// under its `nymbal.visitor` cookie, then the customer's once the guest signs in, in any browser they sign in on.
// Unpublished products leave it, and signing out leaves the browser with none.

const VISITOR = 'nymbal.visitor'
const LOADED = 'nymbal:recently-viewed:loaded'
const PASSWORD = 'TestPassword123!'

interface Viewed extends OwnProduct {
  id: string
}

async function productOf(request: APIRequestContext, token: string): Promise<Viewed> {
  const product = await ownProduct(request, token, 5)
  const res = await request.get(`${API_URL}/api/products/${product.slug}`)
  expect(res.status(), `GET /api/products/${product.slug}`).toBe(200)
  return { ...product, id: ((await res.json()) as { data: { id: string } }).data.id }
}

/** Records every `loaded` the page's recently-viewed element fires, from before its first script runs. */
async function watchLoaded(page: Page): Promise<void> {
  await page.addInitScript((name) => {
    const w = window as unknown as { __recentlyViewedLoaded: string[][] }
    w.__recentlyViewedLoaded = []
    document.addEventListener(name, (e) => {
      w.__recentlyViewedLoaded.push((e as CustomEvent<{ productIds: string[] }>).detail.productIds)
    })
  }, LOADED)
}

/** The ids of every `loaded` the element fired on this page so far. */
function loaded(page: Page): Promise<string[][]> {
  return page.evaluate(
    () =>
      (window as unknown as { __recentlyViewedLoaded?: string[][] }).__recentlyViewedLoaded ?? [],
  )
}

/** Waits until the element has read its list once on this page, and returns what it showed then. */
async function firstRead(page: Page): Promise<string[]> {
  await expect.poll(async () => (await loaded(page)).length, { timeout: 15_000 }).toBeGreaterThan(0)
  return (await loaded(page))[0]!
}

const host = (page: Page) => page.getByTestId('recently-viewed')
const shown = (page: Page): Promise<string[]> => cardSlugs(host(page))

/** Opens a product's page and waits for its view to be captured (the POST's 204) and the list read after it. */
async function view(page: Page, product: Viewed): Promise<string[]> {
  const captured = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/recently-viewed',
    { timeout: 15_000 },
  )
  await page.goto(`/product/${product.slug}`)
  await expect(host(page), `${product.slug}'s page holds the element`).toHaveCount(1)
  expect((await captured).status(), `the view of ${product.slug}`).toBe(204)
  return firstRead(page)
}

/** What `GET /api/recently-viewed` serves this request context (its cookies; no bearer), by product id. */
async function apiList(request: APIRequestContext, headers: Record<string, string> = {}) {
  const res = await request.get(`${API_URL}/api/recently-viewed`, { headers })
  expect(res.status(), 'GET /api/recently-viewed').toBe(200)
  return ((await res.json()) as { data: { items: Array<{ id: string }> } }).data.items.map(
    (p) => p.id,
  )
}

async function visitorCookie(context: BrowserContext) {
  return (await context.cookies(API_URL)).find((c) => c.name === VISITOR)
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/account/login')
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-password').fill(PASSWORD)
  await page.getByTestId('login-submit').click()
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
    timeout: 15_000,
  })
}

async function signOut(page: Page): Promise<void> {
  await page.goto('/account')
  const control = page
    .getByRole('navigation', { name: 'Account navigation' })
    .getByRole('button', { name: /sign out|log ?out/i })
    .or(
      page
        .getByRole('navigation', { name: 'Account navigation' })
        .getByRole('link', { name: /sign out|log ?out/i }),
    )
  await control.click({ timeout: 10_000 })
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account/login', {
    timeout: 10_000,
  })
}

/** A browser context of its own on the project's storefront, with `loaded` watched on its pages. */
async function freshPage(browser: Browser, testInfo: TestInfo, contexts: BrowserContext[]) {
  const baseURL = testInfo.project.use.baseURL
  const context = await browser.newContext(baseURL === undefined ? {} : { baseURL })
  contexts.push(context)
  const page = await context.newPage()
  await watchLoaded(page)
  return page
}

const contexts: BrowserContext[] = []

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close()
})

test.describe('Recently viewed', () => {
  // Kills: a list kept in the browser's storage or read from the cookie rather than from captured views, a fold that
  // leaves the guest's views behind at sign-in, an unpublished product still shown, and a sign-out that leaves the
  // customer's list in the browser.
  test('AC-13: a guest’s views make the list A’s page, B’s page and / show; it follows sign-in to this and a second browser; an unpublished product leaves it; sign-out leaves the browser none', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(180_000)
    const token = await adminToken(request)
    const a = await productOf(request, token)
    const b = await productOf(request, token)
    await watchLoaded(page)

    // A guest: A, then B, then A again.
    expect(await view(page, a), 'A’s page, nothing viewed before').toEqual([])
    expect(await shown(page)).toEqual([])
    expect(await view(page, b), 'B’s page').toEqual([a.id])
    await expect.poll(() => shown(page), { timeout: 10_000 }).toEqual([a.slug])
    expect(await view(page, a), 'A’s page again').toEqual([b.id])
    await expect.poll(() => shown(page), { timeout: 10_000 }).toEqual([b.slug])

    await expect.poll(() => apiList(page.request), { timeout: 10_000 }).toEqual([a.id, b.id])
    await page.goto('/')
    expect(await firstRead(page), '/ as the guest').toEqual(await apiList(page.request))
    await expect.poll(() => shown(page), { timeout: 10_000 }).toEqual([a.slug, b.slug])

    const guestCookie = await visitorCookie(page.context())
    expect(guestCookie?.httpOnly, 'nymbal.visitor is HttpOnly').toBe(true)
    expect(guestCookie?.sameSite).toBe('Lax')

    // A browser that has viewed nothing shows no recently-viewed section on /.
    const nobody = await freshPage(browser, testInfo, contexts)
    await nobody.goto('/')
    expect(await firstRead(nobody)).toEqual([])
    await expect(host(nobody).locator('[part~="section"]')).toHaveCount(0)
    expect(await visitorCookie(nobody.context()), 'a read mints no visitor').toBeUndefined()

    // Sign in as a customer registered through the API: the guest's list becomes the customer's.
    const email = `e2e-recent-${randomUUID().slice(0, 8)}@e2e.test`
    const registered = await request.post(`${API_URL}/api/auth/register`, {
      headers: await csrf(request),
      data: { email, password: PASSWORD, firstName: 'Recent', lastName: 'Viewer' },
    })
    expect(registered.status(), `POST /api/auth/register: ${await registered.text()}`).toBe(201)
    await signIn(page, email)
    await page.goto('/')
    await expect.poll(() => shown(page), { timeout: 10_000 }).toEqual([a.slug, b.slug])
    expect(await visitorCookie(page.context()), 'nymbal.visitor after sign-in').toBeUndefined()
    expect(
      await apiList(request, { cookie: `${VISITOR}=${guestCookie!.value}` }),
      'the old visitor’s list',
    ).toEqual([])

    // The same customer in a second browser: the list is the server's, not this browser's.
    const elsewhere = await freshPage(browser, testInfo, contexts)
    await signIn(elsewhere, email)
    await elsewhere.goto('/')
    await expect.poll(() => shown(elsewhere), { timeout: 10_000 }).toEqual([a.slug, b.slug])

    // A stale access token there: B's view lands on the customer, whether it was refused and sent again after the
    // refresh or sent once the page's other reads had refreshed the token already.
    await elsewhere.evaluate(() =>
      localStorage.setItem('nymbal.auth.accessToken', 'stale.invalid.token'),
    )
    const posts: number[] = []
    elsewhere.on('response', (r) => {
      if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/recently-viewed') {
        posts.push(r.status())
      }
    })
    await elsewhere.goto(`/product/${b.slug}`)
    await expect.poll(() => posts.at(-1), { timeout: 15_000 }).toBe(204)
    expect(posts.length, `the POSTs answered ${posts.join(', ')}`).toBeLessThanOrEqual(2)
    await page.goto('/')
    await expect.poll(() => shown(page), { timeout: 10_000 }).toEqual([b.slug, a.slug])

    // B unpublished through the admin API leaves the list.
    const unpublished = await request.post(`${API_URL}/api/admin/products/${b.id}/unpublish`, {
      headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    })
    expect(unpublished.status(), `unpublish: ${await unpublished.text()}`).toBe(200)
    await page.reload()
    await expect.poll(() => shown(page), { timeout: 10_000 }).toEqual([a.slug])

    // Signed out, the browser has no list; signed in again, the customer's is back.
    await signOut(page)
    await page.goto('/')
    expect(await firstRead(page), '/ signed out').toEqual([])
    await expect(host(page).locator('nymbal-product-card')).toHaveCount(0)
    expect(await apiList(page.request), 'the API from the signed-out browser').toEqual([])
    await signIn(page, email)
    await page.goto('/')
    await expect.poll(() => shown(page), { timeout: 10_000 }).toEqual([a.slug])
  })
})
