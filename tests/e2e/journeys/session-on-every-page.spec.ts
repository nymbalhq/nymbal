import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { cardSlugs } from '../support/elements'
import { expect, test } from '../support/fixtures'
import { storageHolding, watchAccessTokens } from '../support/session'
import { formReady, signIn } from '../support/sign-in'

// AC-9 on both templates (the astro and nextjs projects run this file): the session is restored on every page, not
// only on account, checkout and order pages, and only for a browser that has one. A guest's full loads of /, a product
// page, /cart and /checkout send no POST /api/auth/refresh. A signed-in shopper whose access token lives only in the
// page's memory opens a product page by a full load and is known there: the review form shows, not "Sign in to write a
// review", and the view is filed under the customer (no nymbal.visitor cookie, the customer's list on / has it).

const PASSWORD = 'TestPassword123!'
const REFRESH = '/api/auth/refresh'
const VISITOR = 'nymbal.visitor'

async function registeredShopper(request: APIRequestContext): Promise<string> {
  const email = `e2e-every-page-${randomUUID().slice(0, 8)}@e2e.test`
  const res = await request.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(request),
    data: { email, password: PASSWORD, firstName: 'Every', lastName: 'Page' },
  })
  expect(res.status(), `POST /api/auth/register: ${await res.text()}`).toBe(201)
  return email
}

async function productId(request: APIRequestContext, product: OwnProduct): Promise<string> {
  const res = await request.get(`${API_URL}/api/products/${product.slug}`)
  expect(res.status(), `GET /api/products/${product.slug}`).toBe(200)
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** The product ids `GET /api/recently-viewed` lists for the customer, signed in afresh through the API. */
async function customersList(request: APIRequestContext, email: string): Promise<string[]> {
  const login = await request.post(`${API_URL}/api/auth/login`, {
    headers: await csrf(request),
    data: { email, password: PASSWORD },
  })
  expect(login.ok(), `POST /api/auth/login: ${await login.text()}`).toBe(true)
  const { accessToken } = ((await login.json()) as { data: { accessToken: string } }).data
  const res = await request.get(`${API_URL}/api/recently-viewed`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  expect(res.status(), 'GET /api/recently-viewed').toBe(200)
  return ((await res.json()) as { data: { items: Array<{ id: string }> } }).data.items.map(
    (p) => p.id,
  )
}

test.describe('AC-9: the session on every page, and none for a guest', () => {
  // Kills: a restore that refreshes for every visitor (a 401 and a console error per guest page view), and a restore
  // made only on account, checkout and order pages (the product page reads the shopper as a guest: the sign-in prompt
  // in place of the review form, the view filed under a new visitor).
  test('AC-9: a guest’s full loads of /, a product page, /cart and /checkout send no refresh; signed in, a full load of a product page shows the review form, files the view under the customer and leaves no access token in Web Storage', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000)
    const token = await adminToken(request)
    const browsed = await ownProduct(request, token, 5)
    const viewed = await ownProduct(request, token, 5)
    const viewedId = await productId(request, viewed)
    const context = page.context()
    const refreshes: string[] = []
    context.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === REFRESH) refreshes.push(page.url())
    })

    for (const path of ['/', `/product/${browsed.slug}`, '/cart', '/checkout']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
    }
    const guestRefreshes = [...refreshes]

    // The shopper starts clean: no visitor of the guest's to merge into their list.
    await context.clearCookies()
    const email = await registeredShopper(request)
    const tokens = watchAccessTokens(context)
    await signIn(page, email, PASSWORD)
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
      timeout: 15_000,
    })
    const recorded = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === '/api/recently-viewed' &&
        r.status() === 204,
      { timeout: 15_000 },
    )
    await page.goto(`/product/${viewed.slug}`)
    await recorded
    await page.waitForLoadState('networkidle')
    await formReady(page, 'nymbal-review-form')
    const form = page.locator('nymbal-review-form')

    expect(guestRefreshes, 'refreshes the guest’s page loads sent').toEqual([])
    await expect(form.getByTestId('review-form')).toBeVisible({ timeout: 15_000 })
    await expect(form.getByTestId('review-sign-in')).toHaveCount(0)
    const visitor = (await context.cookies(API_URL)).find((c) => c.name === VISITOR)
    expect(visitor?.value ?? null, 'a nymbal.visitor cookie').toBeNull()
    expect(await customersList(request, email), 'the customer’s recently viewed').toEqual([
      viewedId,
    ])
    const issued = await tokens.all()
    expect(issued.length, 'access tokens the API answered').toBeGreaterThan(0)
    expect(await storageHolding(page, issued), 'Web Storage on the product page').toEqual([])

    await page.goto('/')
    await expect
      .poll(() => cardSlugs(page.getByTestId('recently-viewed')), { timeout: 10_000 })
      .toEqual([viewed.slug])
  })
})
