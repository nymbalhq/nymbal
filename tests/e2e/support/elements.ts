import { randomUUID } from 'node:crypto'
import type { APIRequestContext, BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { adminToken } from './checkout'
import { API_URL, csrf } from './csrf'
import { blockExternalRequests, expect } from './fixtures'
import {
  hostParts,
  noScript,
  rendered,
  tagOf,
  templatesLeft,
  upgraded,
  watchErrors,
} from './server-rendered'

// P2-17 (AC-3, AC-4, AC-7): what the journeys over the new elements share. Every reading is of the parsed DOM:
// Playwright's CSS pierces open shadow roots, the declarative ones Chrome attaches with JavaScript off included.

/** The Next projects (`nextjs-prod`, `nextjs`): the template whose router the element anchors must reach. */
export const isNext = (testInfo: TestInfo): boolean => testInfo.project.name.startsWith('nextjs')

export interface ApiProduct {
  id: string
  slug: string
  name: string
}

export interface ApiPage {
  items: ApiProduct[]
  nextCursor: string | null
}

/** One page of `GET /api/products` with these query parameters. */
export async function apiPage(
  request: APIRequestContext,
  params: Record<string, string>,
): Promise<ApiPage> {
  const qs = new URLSearchParams(params).toString()
  const res = await request.get(`${API_URL}/api/products?${qs}`)
  expect(res.status(), `GET /api/products?${qs}`).toBe(200)
  return ((await res.json()) as { data: ApiPage }).data
}

/** The slugs of the product cards a grid renders, in order (read from each card's `product-card-<slug>`). */
export async function cardSlugs(grid: Locator): Promise<string[]> {
  return grid
    .locator('nymbal-product-card')
    .evaluateAll((cards) =>
      cards.map((card) =>
        (
          card.shadowRoot
            ?.querySelector('[data-testid^="product-card-"]')
            ?.getAttribute('data-testid') ?? ''
        ).slice('product-card-'.length),
      ),
    )
}

/** Marks the page's window; a full load drops the mark, a soft navigation keeps it. */
export async function markWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { __p217Marker?: boolean }).__p217Marker = true
  })
}

export async function windowMarked(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __p217Marker?: boolean }).__p217Marker === true,
  )
}

export interface ServedVariant {
  id: string
  priceMinor: number
  stock: number
  options: Array<{ name: string; value: string }>
}

export interface CatalogProduct {
  id: string
  slug: string
  name: string
  currency: string
  variants: ServedVariant[]
  /** The image URLs the product was given, in order. */
  images: string[]
}

/**
 * An active product of the test's own, in the first seeded category, with one variant per `{ size, priceMinor, stock }`
 * (option `Size`) and `imageCount` images, served by the read side before this returns.
 */
export async function catalogProduct(
  request: APIRequestContext,
  variants: Array<{ size: string; priceMinor: number; stock: number }>,
  imageCount: number,
): Promise<CatalogProduct> {
  const token = await adminToken(request)
  const categories = await request.get(`${API_URL}/api/categories`)
  expect(categories.status(), 'GET /api/categories').toBe(200)
  const category = ((await categories.json()) as { data: Array<{ id: string }> }).data[0]
  expect(category, 'a seeded category').toBeDefined()
  const tag = randomUUID().slice(0, 8)
  const slug = `p2-17-${tag}`
  const images = Array.from(
    { length: imageCount },
    (_, i) => `https://images.example.test/p2-17/${tag}-${i}.jpg`,
  )
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: {
      slug,
      name: `Elements Journey ${tag}`,
      description: 'A product of one P2-17 journey.',
      status: 'active',
      type: 'variable',
      categoryIds: [category!.id],
      media: images.map((url, position) => ({ url, altText: `Image ${position}`, position })),
      variants: variants.map((v, i) => ({
        sku: `P217-${tag}-${i}`,
        name: v.size,
        priceMinor: v.priceMinor,
        stock: v.stock,
        options: [{ name: 'Size', value: v.size }],
      })),
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  await expect
    .poll(async () => (await request.get(`${API_URL}/api/products/${slug}`)).status(), {
      timeout: 10_000,
    })
    .toBe(200)
  const served = await request.get(`${API_URL}/api/products/${slug}`)
  const data = ((await served.json()) as { data: Omit<CatalogProduct, 'images'> }).data
  return { ...data, images }
}

/** The server-rendered hosts of `path` with JavaScript off, in a context holding `from`'s cookies. */
export async function hostsWithScriptOff(
  browser: Parameters<typeof noScript>[0],
  testInfo: TestInfo,
  from: BrowserContext,
  path: string,
): Promise<Record<string, Record<string, number>>> {
  const off = await noScript(browser, testInfo, from)
  try {
    const page = await off.newPage()
    await blockExternalRequests(page)
    await page.goto(path)
    return rendered(await hostParts(page))
  } finally {
    await off.close()
  }
}

/**
 * P2-18 AC-5's reuse on `path` with JavaScript on: every element the JS-off page rendered keeps its per-part counts once
 * upgraded, no `template[shadowrootmode]` is left and the console logs no error. `elements` are the tags the page must
 * have rendered on the server, so the comparison is never vacuous.
 */
export async function expectMarkupReused(
  page: Page,
  browser: Parameters<typeof noScript>[0],
  testInfo: TestInfo,
  path: string,
  elements: string[],
): Promise<void> {
  const off = await hostsWithScriptOff(browser, testInfo, page.context(), path)
  const keys = Object.keys(off)
  expect(
    elements.filter((tag) => !keys.map(tagOf).includes(tag)),
    `elements the server rendered on ${path}`,
  ).toEqual([])

  const errors = watchErrors(page)
  await page.goto(path, { waitUntil: 'load' })
  await upgraded(page, [...new Set(keys.map(tagOf))])
  await expect
    .poll(
      async () => {
        const all = await hostParts(page)
        return Object.fromEntries(keys.map((k) => [k, all[k] ?? null]))
      },
      { timeout: 10_000, message: `part counts on ${path}` },
    )
    .toEqual(off)
  expect(await templatesLeft(page), `templates left on ${path}`).toBe(0)
  expect(errors, `errors on ${path}`).toEqual([])
}
