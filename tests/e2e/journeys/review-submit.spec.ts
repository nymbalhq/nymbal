import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { formReady, signIn, submitSignInForm } from '../support/sign-in'

// On both templates (the astro and nextjs projects run this file): a signed-in shopper reviews a product from its page,
// once however often Submit is clicked; the review waits for moderation, and once approved it is in the page's review
// list; a second review of the product shows the store's refusal in the form. A signed-out shopper sees a link to sign
// in where the form would be, and signing in from it comes back to the product with the form.

const PASSWORD = 'TestPassword123!'
const THANKS = 'Thank you! Your review will appear once it is approved.'

interface Shopper {
  id: string
  email: string
}

interface AdminReview {
  id: string
  productId: string
  customerId: string | null
  moderationStatus: string
}

async function registeredShopper(request: APIRequestContext): Promise<Shopper> {
  const email = `reviewer-${randomUUID().slice(0, 8)}@e2e.test`
  const res = await request.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(request),
    data: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Reviewer' },
  })
  expect(res.status(), `POST /api/auth/register: ${await res.text()}`).toBe(201)
  const body = (await res.json()) as { data: { customer: { id: string } } }
  return { id: body.data.customer.id, email }
}

async function productIdOf(request: APIRequestContext, product: OwnProduct): Promise<string> {
  const res = await request.get(`${API_URL}/api/products/${product.slug}`)
  expect(res.status(), `GET /api/products/${product.slug}`).toBe(200)
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** The product's reviews `GET /api/admin/reviews` lists as pending. */
async function pendingOf(
  request: APIRequestContext,
  token: string,
  productId: string,
): Promise<AdminReview[]> {
  const res = await request.get(`${API_URL}/api/admin/reviews`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/reviews: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: AdminReview[] }).data.filter(
    (r) => r.productId === productId,
  )
}

/** The answer `POST /api/reviews` gives the shopper, signed in afresh through the API. */
async function submittedThroughApi(
  request: APIRequestContext,
  shopper: Shopper,
  productId: string,
): Promise<{ status: number; code: string | undefined; message: string | undefined }> {
  const login = await request.post(`${API_URL}/api/auth/login`, {
    headers: await csrf(request),
    data: { email: shopper.email, password: PASSWORD },
  })
  expect(login.ok(), `POST /api/auth/login: ${await login.text()}`).toBe(true)
  const { accessToken } = ((await login.json()) as { data: { accessToken: string } }).data
  const res = await request.post(`${API_URL}/api/reviews`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${accessToken}` },
    data: { productId, rating: 3, title: 'Again', body: 'A second go.' },
  })
  const body = (await res.json()) as { error?: { code: string; message: string } }
  return { status: res.status(), code: body.error?.code, message: body.error?.message }
}

/** Opens the product's page and waits for its review form element to have upgraded and rendered. */
async function openProduct(page: Page, product: OwnProduct): Promise<void> {
  await page.goto(`/product/${product.slug}`)
  await formReady(page, 'nymbal-review-form')
}

async function fillReview(
  page: Page,
  review: { rating: number; title: string; body: string },
): Promise<void> {
  const form = page.locator('nymbal-review-form')
  await expect(form.getByTestId('review-form')).toBeVisible({ timeout: 15_000 })
  await form.getByTestId('review-rating').selectOption(String(review.rating))
  await form.getByTestId('review-title').fill(review.title)
  await form.getByTestId('review-body').fill(review.body)
}

const onAccountHome = (url: URL): boolean => url.pathname.replace(/\/$/, '') === '/account'

test.describe('A signed-in shopper reviews a product', () => {
  // Kills: the form posting to a route that does not exist; k clicks making k reviews; the store's refusal hidden behind
  // the generic text.
  test('AC-9: a double-clicked Submit shows the thanks and makes one pending review by that shopper; once approved the reloaded page lists it with its title and rating; a second review of the product shows the store’s already-reviewed message in the form', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const productId = await productIdOf(request, product)
    const shopper = await registeredShopper(request)
    const review = { rating: 4, title: `Sturdy ${randomUUID().slice(0, 6)}`, body: 'Held up well.' }

    await signIn(page, shopper.email, PASSWORD)
    await page.waitForURL(onAccountHome, { timeout: 15_000 })
    await openProduct(page, product)
    await fillReview(page, review)
    await page.locator('nymbal-review-form').getByTestId('review-submit').dblclick()

    await expect(page.locator('nymbal-review-form [role="status"]')).toHaveText(THANKS, {
      timeout: 15_000,
    })
    await expect(page.locator('nymbal-review-form [part~="error"]')).toHaveCount(0)
    const pending = await pendingOf(request, token, productId)
    expect(pending.map((r) => [r.customerId, r.moderationStatus])).toEqual([
      [shopper.id, 'pending'],
    ])

    const moderated = await request.post(
      `${API_URL}/api/admin/reviews/${pending[0]!.id}/moderate`,
      {
        headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
        data: { status: 'approved' },
      },
    )
    expect(moderated.status(), `moderate: ${await moderated.text()}`).toBe(200)
    // Approval takes exactly that review off the pending list.
    expect(await pendingOf(request, token, productId)).toEqual(
      pending.filter((r) => r.id !== pending[0]!.id),
    )

    // The page's reviews may come from a cache that lasts a minute: reload until the approved review is in the list.
    const listed = page.locator(`nymbal-review-list [data-testid="review-${pending[0]!.id}"]`)
    await expect
      .poll(
        async () => {
          await page.reload()
          return listed.count()
        },
        { timeout: 120_000, intervals: [1_000, 5_000, 10_000] },
      )
      .toBe(1)
    await expect(listed.locator('h3')).toHaveText(review.title)
    await expect(listed.locator('[part~="rating"]')).toHaveAttribute(
      'aria-label',
      `${review.rating} out of 5 stars`,
    )

    await formReady(page, 'nymbal-review-form')
    await fillReview(page, { rating: 2, title: 'Second thoughts', body: 'Changed my mind.' })
    await page.locator('nymbal-review-form').getByTestId('review-submit').click()
    const refusal = await submittedThroughApi(request, shopper, productId)
    expect([refusal.status, refusal.code]).toEqual([409, 'reviews.already_reviewed'])
    await expect(page.locator('nymbal-review-form [part~="error"]')).toHaveText(refusal.message!, {
      timeout: 15_000,
    })
    expect((await pendingOf(request, token, productId)).length).toBe(0)
  })
})

test.describe('A signed-out shopper is asked to sign in to review', () => {
  // Kills: a guest given a form whose every submit fails 401.
  test('AC-10: a signed-out shopper sees review-sign-in and no review-form once the page has upgraded; following it and signing in lands back on /product/<slug> with the form shown', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const product = await ownProduct(request, await adminToken(request), 5)
    const shopper = await registeredShopper(request)
    const path = `/product/${product.slug}`
    const form = page.locator('nymbal-review-form')

    await openProduct(page, product)

    const link = form.getByTestId('review-sign-in')
    await expect(link).toHaveText('Sign in to write a review', { timeout: 15_000 })
    await expect(link).toHaveAttribute(
      'href',
      `/account/login?redirect=${encodeURIComponent(path)}`,
    )
    await expect(form.getByTestId('review-form')).toHaveCount(0)

    await link.click()
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account/login', {
      timeout: 15_000,
    })
    await submitSignInForm(page, shopper.email, PASSWORD)
    await page.waitForURL((url) => url.pathname === path, { timeout: 15_000 })
    await formReady(page, 'nymbal-review-form')

    await expect(form.getByTestId('review-form')).toBeVisible({ timeout: 15_000 })
    await expect(form.getByTestId('review-sign-in')).toHaveCount(0)
  })
})
