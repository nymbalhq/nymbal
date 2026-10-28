import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

test.describe('Error pages', () => {
  // Kills: an unknown page answered 200 (a soft 404 a crawler indexes), a redirect to /404 in place of a 404 at the
  // URL asked for, a blank error page, and one with no way home.
  test('an unknown path, and a product, a category or an order the API does not know, answer 404 at their own URL with the branded page: the site header, a not-found message and a link home that loads', async ({
    page,
    request,
  }) => {
    const slug = 'this-product-does-not-exist-404-test'
    const api = await request.get(`${API_URL}/api/products/${slug}`)
    expect(api.status(), 'the API knows no such product').toBe(404)
    const categorySlug = 'this-category-does-not-exist-404-test'
    const categories = await request.get(`${API_URL}/api/categories`)
    expect(categories.status()).toBe(200)
    const known = ((await categories.json()) as { data: { slug: string }[] }).data.map(
      (c) => c.slug,
    )
    expect(known.length, 'the store has categories').toBeGreaterThan(0)
    expect(known, 'the API knows no such category').not.toContain(categorySlug)
    const orderNumber = 'this-order-does-not-exist-404-test'
    const order = await request.get(`${API_URL}/api/orders/${orderNumber}`)
    expect(order.status(), 'the API knows no such order').toBe(404)

    for (const path of [
      '/this-page-does-not-exist-404-test',
      `/product/${slug}`,
      `/category/${categorySlug}`,
      `/order/${orderNumber}`,
    ]) {
      const missing = await page.goto(path)
      expect(missing, path).not.toBeNull()
      expect(missing!.request().redirectedFrom(), `${path} answers without a redirect`).toBeNull()
      expect(new URL(missing!.url()).pathname, path).toBe(path)
      expect(missing!.status(), path).toBe(api.status())
      await expect(page.getByTestId('site-header'), path).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('body'), path).toContainText(/404|not found/i)
    }

    await page.locator('a[href="/"]').first().click()
    await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 })
    const home = await page.request.get('/')
    expect(home.status()).toBeLessThan(400)
  })
})
