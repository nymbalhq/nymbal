import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { upgraded } from '../support/server-rendered'

// P2-17 AC-5, the E2E half, on both templates (the mandatory double-submit criterion; the unit property is
// packages/web-components/src/components/review-form.test.ts): on a product page, `nymbal-review-form`'s submit
// clicked k times in one go sends exactly one request to `/api/reviews`, counted on the network. The platform has no
// such route today (spec review B1, unowned on the board), so it answers 404: the form's `error` part shows and its
// submit is enabled again. Kills: a form whose handler is not guarded while in flight, so k clicks make k requests;
// a refusal that leaves the form stuck.

const PDP = 'ceramic-mug'
const CLICKS = 4

test.describe('P2-17 AC-5: the review form submits once per click', () => {
  test(`AC-5: ${CLICKS} rapid clicks on nymbal-review-form’s submit send exactly one POST /api/reviews; its 404 shows the error part and re-enables submit`, async ({
    page,
  }) => {
    const productRes = await page.request.get(`${API_URL}/api/products/${PDP}`)
    expect(productRes.status()).toBe(200)
    const product = ((await productRes.json()) as { data: { id: string } }).data
    const posts: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/reviews') posts.push(r.url())
    })

    await page.goto(`/product/${PDP}`, { waitUntil: 'load' })
    await upgraded(page, ['nymbal-review-form'])
    const form = page.locator('nymbal-review-form')
    const rating = form.getByTestId('review-rating')
    if ((await rating.evaluate((el) => el.localName)) === 'select') await rating.selectOption('5')
    else await rating.fill('5')
    await form.getByTestId('review-title').fill('Submitted once')
    await form.getByTestId('review-body').fill('Four clicks make one review.')

    const answered = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/reviews',
    )
    // The clicks a shopper's double (or quadruple) click makes, with no turn of the event loop between them.
    await form.getByTestId('review-submit').evaluate((button, k) => {
      for (let i = 0; i < k; i += 1) (button as HTMLButtonElement).click()
    }, CLICKS)
    const response = await answered
    expect(response.status(), 'POST /api/reviews has no route').toBe(404)
    // The one request is this product's review, with what the shopper typed.
    expect(response.request().postDataJSON()).toEqual({
      productId: product.id,
      rating: 5,
      title: 'Submitted once',
      body: 'Four clicks make one review.',
    })

    const error = form.locator('[part~="error"]')
    await expect(error).toBeVisible({ timeout: 10_000 })
    await expect(error).not.toHaveText('')
    await expect(form.getByTestId('review-submit')).toBeEnabled()
    expect(posts.length, `requests for ${CLICKS} clicks`).toBeLessThan(CLICKS)
    expect(posts.length, `requests for ${CLICKS} clicks`).toBe(1)
  })
})
