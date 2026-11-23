import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// On both templates a product made through the admin API with a brand and one variant holding a GTIN states both in
// its product page's Product JSON-LD, and the UCP product feed lists it with the brand as metadata and the GTIN as its
// variant's barcode. A product made with neither has neither key, on the page or in the feed.

const GTIN = '4006381333931'

type Json = Record<string, unknown>

/** An active product made through the admin API, once its storefront document is served. */
async function makeProduct(
  request: APIRequestContext,
  fields: { brand?: string; gtin?: string },
): Promise<string> {
  const token = await adminToken(request)
  const slug = `identifiers-${randomUUID().slice(0, 8)}`
  const made = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: {
      slug,
      name: `Identified Lamp ${slug}`,
      description: 'A lamp with a barcode.',
      status: 'active',
      ...(fields.brand !== undefined && { brand: fields.brand }),
      variants: [
        {
          sku: `ID-${slug}`,
          name: 'Default',
          priceMinor: 3100,
          stock: 4,
          options: [],
          ...(fields.gtin !== undefined && { gtin: fields.gtin }),
        },
      ],
    },
  })
  expect(made.status(), `POST /api/admin/products: ${await made.text()}`).toBe(201)
  await expect
    .poll(async () => (await request.get(`${API_URL}/api/products/${slug}`)).status(), {
      timeout: 10_000,
    })
    .toBe(200)
  return slug
}

/** The page's one Product JSON-LD. */
async function productJsonLd(page: Page): Promise<Json[]> {
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents()
  return scripts
    .map((s) => JSON.parse(s) as Json | Json[])
    .flatMap((ld) => (Array.isArray(ld) ? ld : [ld]))
    .filter((ld) => ld['@type'] === 'Product')
}

/** Every product of the UCP product feed, walked by its cursor. */
async function feedProducts(request: APIRequestContext): Promise<Json[]> {
  const products: Json[] = []
  let cursor: string | undefined
  for (let page = 0; page < 200; page += 1) {
    const res = await request.get(
      `${API_URL}/agents/products.json${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
    )
    expect(res.status()).toBe(200)
    const body = (await res.json()) as {
      products: Json[]
      pagination?: { has_next_page: boolean; cursor?: string }
    }
    products.push(...body.products)
    if (body.pagination?.has_next_page !== true) break
    cursor = body.pagination.cursor
  }
  return products
}

test.describe('the product page and the product feed state a product’s brand and GTIN', () => {
  test('AC-9: a product made with a brand and one variant holding a GTIN has a Product JSON-LD with that brand.name and gtin and is listed in the feed with that brand and barcode; one made with neither has neither key on its page or in the feed', async ({
    page,
    request,
  }) => {
    const brand = `Acme ${randomUUID().slice(0, 6)}`
    const identified = await makeProduct(request, { brand, gtin: GTIN })
    const plain = await makeProduct(request, {})

    await page.goto(`/product/${identified}`)
    const [first] = await productJsonLd(page)
    await page.goto(`/product/${plain}`)
    const [second] = await productJsonLd(page)

    expect([first?.['brand'], first?.['gtin']]).toEqual([{ '@type': 'Brand', name: brand }, GTIN])
    expect([second?.['name'], 'brand' in (second ?? {}), 'gtin' in (second ?? {})]).toEqual([
      `Identified Lamp ${plain}`,
      false,
      false,
    ])

    const feed = await feedProducts(request)
    const listed = (slug: string) => {
      const product = feed.find((p) => p['id'] === slug)
      const variants = (product?.['variants'] ?? []) as Json[]
      return {
        listed: product !== undefined,
        metadata: product !== undefined && 'metadata' in product ? product['metadata'] : 'absent',
        barcodes: variants.map((v) => ('barcodes' in v ? v['barcodes'] : 'absent')),
      }
    }
    expect(listed(identified)).toEqual({
      listed: true,
      metadata: { brand },
      barcodes: [[{ type: 'GTIN', value: GTIN }]],
    })
    expect(listed(plain)).toEqual({ listed: true, metadata: 'absent', barcodes: ['absent'] })
  })
})
