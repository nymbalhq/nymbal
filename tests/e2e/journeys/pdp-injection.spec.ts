import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// On both templates a product whose name closes the JSON-LD script element and whose description carries a script
// and an event handler runs nothing on its product page: the Product JSON-LD still parses with the API's own name,
// and the description, its meta tag and its JSON-LD field all read `Soft & warm`, never `&amp;`.

const NAME = 'Tee </script><script>window.__nymbalXss=1</script>'
const DESCRIPTION =
  '<p>Soft & warm</p><script>window.__nymbalXss=2</script><img src=x onerror="window.__nymbalXss=3">'
const SHOWN = 'Soft & warm'

/** The product's name as the API serves it. */
async function servedName(request: APIRequestContext, slug: string): Promise<string> {
  const res = await request.get(`${API_URL}/api/products/${slug}`)
  return ((await res.json()) as { data: { name: string } }).data.name
}

test.describe('AC-2: a product page runs nothing a product name or description carries', () => {
  test('AC-2: a product named with </script> and described with a script and an onerror handler, made through the admin API, runs no script on its PDP; its Product JSON-LD parses with the API’s name, and the description, meta description and JSON-LD description read Soft & warm', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const slug = `injection-${randomUUID().slice(0, 8)}`
    const made = await request.post(`${API_URL}/api/admin/products`, {
      headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
      data: {
        slug,
        name: NAME,
        description: DESCRIPTION,
        status: 'active',
        variants: [
          { sku: `INJ-${slug}`, name: 'Default', priceMinor: 1500, stock: 3, options: [] },
        ],
      },
    })
    expect(made.status(), `POST /api/admin/products: ${await made.text()}`).toBe(201)
    await expect
      .poll(async () => (await request.get(`${API_URL}/api/products/${slug}`)).status(), {
        timeout: 10_000,
      })
      .toBe(200)

    await page.goto(`/product/${slug}`)
    await page.waitForLoadState('load')
    const ran = await page.evaluate(
      () => (window as unknown as { __nymbalXss?: unknown }).__nymbalXss,
    )
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents()
    const parsed = blocks.map((text): Record<string, unknown> => {
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        return { unparsed: text }
      }
    })
    const products = parsed.filter((block) => block['@type'] === 'Product')

    expect(ran).toBeUndefined()
    expect(parsed.filter((block) => 'unparsed' in block)).toEqual([])
    expect(products.map((p) => p.name)).toEqual([await servedName(request, slug)])
    await expect(page.getByTestId('product-description')).toHaveText(SHOWN)
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', SHOWN)
    expect(products.map((p) => p.description)).toEqual([SHOWN])
  })
})
