import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

test.describe('Error pages', () => {
  // Kills: an unknown page answered 200 (a soft 404 a crawler indexes), a blank error page, and one with no way home.
  test('an unknown path and a product the API does not know answer 404 with the branded page: the site header, a not-found message and a link home that loads', async ({
    page,
    request,
  }) => {
    const slug = 'this-product-does-not-exist-404-test'
    const api = await request.get(`${API_URL}/api/products/${slug}`)
    expect(api.status(), 'the API knows no such product').toBe(404)

    for (const path of ['/this-page-does-not-exist-404-test', `/product/${slug}`]) {
      const missing = await page.goto(path)
      expect(missing?.status(), path).toBe(api.status())
      await expect(page.getByTestId('site-header'), path).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('body'), path).toContainText(/404|not found/i)
    }

    await page.locator('a[href="/"]').first().click()
    await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 })
    const home = await page.request.get('/')
    expect(home.status()).toBeLessThan(400)
  })
})
