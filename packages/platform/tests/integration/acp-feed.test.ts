import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import {
  acpClient,
  acpStore,
  createBody,
  PRODUCTS_RESPONSE,
  requestPairs,
  sessionPairs,
  type FeedProduct,
} from '../support/acp.js'
import type { AgentStore } from '../support/agents.js'

// AC-11: GET /api/acp/feed is ACP's ProductsResponse over the whole listed catalogue, every page of it, priced and
// stocked as the read model says, naming only ids checkout takes.

const LISTED = 150

interface RouteProduct {
  slug: string
  priceRange: { minMinor: number; maxMinor: number } | null
  currency: string | null
  variants: Array<{ id: string; priceMinor: number; stock: number }>
}

let store: AgentStore
/** The slug of the one active product with no sellable variant. */
let unsellable: string

/** A generated catalogue: 1-3 variants per product, prices in minor units, stock often 0. */
const catalogue = fc.sample(
  fc.array(
    fc.record({
      priceMinor: fc.integer({ min: 1, max: 99_999 }),
      stock: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 4 })),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  { numRuns: LISTED, seed: 11 },
)

async function listed(): Promise<RouteProduct[]> {
  const all: RouteProduct[] = []
  let cursor: string | null | undefined
  do {
    const res = await fetch(
      new URL(
        `/api/products?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        store.baseUrl,
      ),
    )
    const body = (await res.json()) as {
      data?: { items: RouteProduct[]; nextCursor: string | null }
    }
    if (res.status !== 200)
      throw new Error(`GET /api/products: ${res.status} ${JSON.stringify(body)}`)
    all.push(...(body.data?.items ?? []))
    cursor = body.data?.nextCursor
  } while (cursor)
  return all
}

beforeAll(async () => {
  store = await acpStore()
  const slugs: string[] = []
  for (const [i, variants] of catalogue.entries()) {
    const slug = `feed-${i}-${randomUUID().slice(0, 8)}`
    await store.kernel.services.product.create({
      slug,
      name: `Feed Lamp ${i}`,
      description: `Lamp ${i} of the feed.`,
      status: 'active',
      variants: variants.map((v, j) => ({
        sku: `FEED-${i}-${j}-${randomUUID().slice(0, 6)}`,
        name: `Finish ${j + 1}`,
        priceMinor: v.priceMinor,
        stock: v.stock,
        lowStockThreshold: 0,
        options: [],
      })),
    })
    slugs.push(slug)
  }
  unsellable = `feed-unsellable-${randomUUID().slice(0, 8)}`
  await store.kernel.services.product.create({
    slug: unsellable,
    name: 'Feed Lamp Unsellable',
    description: '',
    status: 'active',
    variants: [],
  })
  slugs.push(unsellable)
  await vi.waitFor(
    async () => {
      const served = new Set((await listed()).map((p) => p.slug))
      const missing = slugs.filter((s) => !served.has(s))
      if (missing.length > 0) throw new Error(`${missing.length} products not listed yet`)
    },
    { timeout: 30_000, interval: 100 },
  )
}, 180_000)

afterAll(async () => {
  await store?.stop()
})

describe('AC-11: the ACP product feed', () => {
  // Kills: a feed that stops after the first page; prices leaving minor units; stock read as available; an unsellable
  // product served; a product listed twice; ids (a SKU, a product id) that checkout refuses.
  it('AC-11: over 150 generated listed products and one with no sellable variant, the feed validates as ProductsResponse, names every priced listed slug exactly once and not the unsellable one, gives each variant the read model’s id, priceMinor, currency and stock > 0, and every variant id it names is taken by create: in stock it opens a session, out of stock it is refused out_of_stock, never as an unknown item', async () => {
    const feed = await acpClient(store.baseUrl).feed()
    expect(feed.status, JSON.stringify(feed.body).slice(0, 500)).toBe(200)
    const products: FeedProduct[] = feed.body.products ?? []
    const readModel = (await listed()).filter((p) => p.priceRange !== null)
    const ids = products.map((p) => p.id)

    expect(validateAcp(PRODUCTS_RESPONSE, feed.body)).toEqual([])
    expect(readModel.length).toBe(LISTED)
    expect([...ids].sort()).toEqual(readModel.map((p) => p.slug).sort())
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(unsellable)
    for (const product of readModel) {
      const served = products.find((p) => p.id === product.slug)
      const shape = (variants: Array<Record<string, unknown>>) =>
        variants.sort((a, b) => String(a['id']).localeCompare(String(b['id'])))
      expect(
        shape(
          (served?.variants ?? []).map((v) => ({
            id: v.id,
            amount: v.price?.amount,
            currency: v.price?.currency,
            available: v.availability?.available,
            status: v.availability?.status,
          })),
        ),
        product.slug,
      ).toEqual(
        shape(
          product.variants.map((v) => ({
            id: v.id,
            amount: v.priceMinor,
            currency: product.currency,
            available: v.stock > 0,
            status: v.stock > 0 ? 'in_stock' : 'out_of_stock',
          })),
        ),
      )
    }

    const variants = products.flatMap((p) => p.variants)
    const inStock = variants.filter((v) => v.availability?.available === true)
    const outOfStock = variants.filter((v) => v.availability?.available !== true)
    const agent = acpClient(store.baseUrl)
    for (let at = 0; at < inStock.length; at += 50) {
      const lines = inStock.slice(at, at + 50).map((v) => ({ variantId: v.id, quantity: 1 }))
      const opened = await agent.create(createBody(lines))
      expect(opened.status, JSON.stringify(opened.body).slice(0, 300)).toBe(201)
      expect(sessionPairs(opened.body)).toEqual(requestPairs(lines))
    }
    for (const v of outOfStock) {
      const refused = await agent.create(createBody([{ variantId: v.id, quantity: 1 }]))
      expect({ id: v.id, status: refused.status, code: refused.body.code }).toEqual({
        id: v.id,
        status: 400,
        code: 'out_of_stock',
      })
    }
    expect(inStock.length + outOfStock.length).toBe(
      readModel.reduce((n, p) => n + p.variants.length, 0),
    )
  }, 180_000)
})
