import { randomUUID } from 'node:crypto'
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { ADMIN_EMAIL, ADMIN_PASSWORD, signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct, type OwnProduct } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { phoneWidths } from '../../support/phone-width'

// A shopper of the journey's own reviews a product of its own through the API; the merchant moderates it on
// /admin/reviews. Approve is one decision however often it is clicked, the review is then public and on the Approved
// tab, and Reject there takes it out of the public list and the product's rating again. At a phone's width the page
// holding a review whose body is one long word is no wider than the viewport.

interface Submitted {
  product: OwnProduct
  productId: string
  reviewId: string
  title: string
}

async function productIdOf(request: APIRequestContext, slug: string): Promise<string> {
  const res = await request.get(`${API_URL}/api/products/${slug}`)
  expect(res.status(), `GET /api/products/${slug}`).toBe(200)
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** A product of its own and a pending review of it by a shopper registered for it, through the API. */
async function submittedReview(request: APIRequestContext, body: string): Promise<Submitted> {
  const token = await adminToken(request)
  const product = await ownProduct(request, token, 5)
  const productId = await productIdOf(request, product.slug)
  const title = `Moderated ${randomUUID().slice(0, 8)}`
  const shopper = await playwrightRequest.newContext()
  try {
    const registered = await shopper.post(`${API_URL}/api/auth/register`, {
      headers: await csrf(shopper),
      data: {
        email: `moderated-${randomUUID().slice(0, 8)}@e2e.test`,
        password: 'TestPassword123!',
        firstName: 'Ada',
        lastName: 'Reviewer',
      },
    })
    expect(registered.status(), `POST /api/auth/register: ${await registered.text()}`).toBe(201)
    const { accessToken } = ((await registered.json()) as { data: { accessToken: string } }).data
    const res = await shopper.post(`${API_URL}/api/reviews`, {
      headers: { ...(await csrf(shopper)), authorization: `Bearer ${accessToken}` },
      data: { productId, rating: 4, title, body },
    })
    expect(res.status(), `POST /api/reviews: ${await res.text()}`).toBe(200)
    const reviewId = ((await res.json()) as { data: { review: { id: string } } }).data.review.id
    return { product, productId, reviewId, title }
  } finally {
    await shopper.dispose()
  }
}

async function publicIds(request: APIRequestContext, productId: string): Promise<string[]> {
  const res = await request.get(`${API_URL}/api/products/${productId}/reviews`)
  expect(res.status(), `GET /api/products/${productId}/reviews`).toBe(200)
  return ((await res.json()) as { data: { items: Array<{ id: string }> } }).data.items.map(
    (r) => r.id,
  )
}

async function pendingIds(request: APIRequestContext, token: string): Promise<string[]> {
  const res = await request.get(`${API_URL}/api/admin/reviews`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/reviews: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id)
}

/** The applied review.moderate entries the audit trail holds for one review. */
async function decisionsAbout(
  request: APIRequestContext,
  token: string,
  reviewId: string,
): Promise<number> {
  const query = new URLSearchParams({ command: 'review.moderate', subject: reviewId })
  const res = await request.get(`${API_URL}/api/admin/activity?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/activity: ${await res.text()}`).toBe(200)
  const entries = ((await res.json()) as { data: Array<{ outcome: string }> }).data
  return entries.filter((e) => e.outcome === 'applied').length
}

/** The POSTs the page sends to `pattern`; `settled()` waits until each has been answered. */
function watchPosts(page: Page, pattern: RegExp): { sent(): number; settled(): Promise<void> } {
  let sent = 0
  let answered = 0
  const matches = (r: { method(): string; url(): string }) =>
    r.method() === 'POST' && pattern.test(new URL(r.url()).pathname)
  page.on('request', (r) => {
    if (matches(r)) sent += 1
  })
  const onAnswered = (r: { method(): string; url(): string }) => {
    if (matches(r)) answered += 1
  }
  page.on('requestfinished', onAnswered)
  page.on('requestfailed', onAnswered)
  return {
    sent: () => sent,
    async settled() {
      await expect.poll(() => sent - answered, { message: 'POSTs still in flight' }).toBe(0)
    },
  }
}

test.describe('The merchant moderates a review', () => {
  // Kills: no reviews page (fails on base); a double click that decides twice; a changed decision that leaves the
  // review public or counted in the product's rating.
  test('AC-9: a shopper’s review shows on /admin/reviews; a double-clicked Approve is one decision that puts it once in the public list, off the pending list and on the Approved tab; Reject there takes it out of the public list and leaves the product with rating null', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const submitted = await submittedReview(request, 'Held up to a year of daily use.')
    const token = await adminToken(request)
    const row = page.getByTestId(`admin-reviews-row-${submitted.reviewId}`)

    await signInAsAdmin(page)
    await page.goto('reviews')
    await expect(row).toContainText(submitted.title, { timeout: 15_000 })

    const posts = watchPosts(
      page,
      new RegExp(`^/api/admin/reviews/${submitted.reviewId}/moderate$`),
    )
    await page.getByTestId(`admin-reviews-approve-${submitted.reviewId}`).dblclick()
    await posts.settled()
    await expect(page.getByTestId('admin-reviews-result')).toHaveText(
      `Approved the review of ${submitted.product.name}`,
      { timeout: 15_000 },
    )

    expect(
      await decisionsAbout(request, token, submitted.reviewId),
      `${posts.sent()} POSTs sent`,
    ).toBe(1)
    expect(await publicIds(request, submitted.productId)).toEqual([submitted.reviewId])
    expect((await pendingIds(request, token)).filter((id) => id === submitted.reviewId)).toEqual([])
    await expect(row).toHaveCount(0)

    await page.getByTestId('admin-reviews-tab-approved').click()
    await expect(row).toContainText(submitted.title, { timeout: 15_000 })
    await page.getByTestId(`admin-reviews-reject-${submitted.reviewId}`).click()
    await expect(page.getByTestId('admin-reviews-result')).toHaveText(
      `Rejected the review of ${submitted.product.name}`,
      { timeout: 15_000 },
    )
    await expect(row).toHaveCount(0)

    expect(await publicIds(request, submitted.productId)).toEqual([])
    const product = await request.get(`${API_URL}/api/products/${submitted.product.slug}`)
    expect(product.status()).toBe(200)
    expect(((await product.json()) as { data: { rating: unknown } }).data.rating).toBeNull()
  })
})

test.describe('Reviews at a phone’s width @phone-width', () => {
  // Kills: a review body of one unbroken word that widens the page past a phone's viewport.
  test('AC-10: /admin/reviews holding a review whose body is one unbroken 300-character word is no wider than the viewport, and the review’s row ends inside it', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const body = `${'w'.repeat(299)}x`
    const submitted = await submittedReview(request, body)
    const rowId = `admin-reviews-row-${submitted.reviewId}`

    // Through the form: signInAsAdmin waits for a sidebar link the phone's off-canvas sidebar hides.
    await page.goto('login')
    await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
    await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('admin-login-submit').click()
    await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
      timeout: 15_000,
    })
    await page.goto('reviews')
    await expect(page.getByTestId(rowId)).toContainText(body, { timeout: 15_000 })
    await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: 10_000 })

    const { scrollWidth, innerWidth, viewport, measured } = await phoneWidths(page, 'reviews')
    expect.soft(scrollWidth, measured).toBeLessThanOrEqual(viewport + 1)
    expect.soft(innerWidth, measured).toBe(viewport)
    const box = await page.getByTestId(rowId).boundingBox()
    const right = box === null ? Number.POSITIVE_INFINITY : box.x + box.width
    expect(right, `${rowId}: right edge ${right}, viewport ${viewport}`).toBeLessThanOrEqual(
      viewport + 1,
    )
  })
})
