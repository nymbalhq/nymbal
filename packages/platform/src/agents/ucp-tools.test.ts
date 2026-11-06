import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToolSurface } from '@nymbalhq/types'
import { validateUcp } from '../../../../tests/fixtures/ucp/validate.js'
import { createKernel, type Kernel } from '../../tests/support/kernel.js'
import { serveKernel, type ServedKernel } from '../../tests/support/http.js'
import { ANONYMOUS, committedCount, committedStock, toolSurface } from '../../tests/support/mcp.js'
import { unaudited } from '../../tests/support/write-audit.js'
import { createUcpSurface } from './ucp-surface.js'

// AC-4 to AC-7: the UCP tools over a SQLite kernel served over HTTP, so each answer is held against what the store's
// own routes answer for the same catalogue and cart. The surface is built as the spec's interface gives it: over the
// app's route tools, with the store's variant and cart reads.

const STOREFRONT = 'https://shop.example'
const LINKS = [
  { type: 'privacy_policy', url: 'https://shop.example/privacy', title: 'Privacy' },
  { type: 'terms_of_service', url: 'https://shop.example/terms' },
]

interface RouteProduct {
  id: string
  slug: string
  name: string
  priceRange: { minMinor: number; maxMinor: number } | null
  currency: string | null
  variants: Array<{ id: string; priceMinor: number; stock: number }>
}

interface UcpVariant {
  id: string
  price: { amount: number; currency: string }
  availability?: { available?: boolean }
  inputs?: Array<{ id: string; match?: string }>
}

interface UcpProduct {
  id: string
  title: string
  price_range: {
    min: { amount: number; currency: string }
    max: { amount: number; currency: string }
  }
  variants: UcpVariant[]
}

interface UcpMessage {
  type: string
  code: string
  severity?: string
  path?: string
  content?: string
}

type Payload = Record<string, unknown> & {
  ucp?: { status?: string }
  messages?: UcpMessage[]
}

interface Answer {
  isError: boolean
  payload: Payload
}

/** One seeded product: its slug, name and variants as created. */
interface Seeded {
  slug: string
  name: string
  variants: Array<{ id: string; priceMinor: number; stock: number }>
}

let served: ServedKernel
let kernel: Kernel
let tools: ToolSurface
let tag: string
/** Three variants at different prices, one out of stock. */
let brass: Seeded
/** Six products of two in-stock variants each: the checkout pool. */
let pool: Seeded[]
/** One variant at stock 3. */
let scarce: Seeded
/** Active with no variant: no price range, so in no UCP answer. */
let empty: Seeded
/** One variant at stock 200, for the line-count and quantity bounds. */
let bulk: Seeded

async function seed(
  name: string,
  variants: Array<{ priceMinor: number; stock: number }>,
): Promise<Seeded> {
  const slug = `ucp-${randomUUID()}`
  const product = await kernel.services.product.create({
    slug,
    name,
    description: '',
    status: 'active',
    variants: variants.map((v, i) => ({
      sku: `UCP-${randomUUID()}`,
      name: `Size ${i + 1}`,
      priceMinor: v.priceMinor,
      stock: v.stock,
      lowStockThreshold: 0,
      options: [],
    })),
  })
  return {
    slug,
    name,
    variants: product.variants.map((v) => ({ id: v.id, priceMinor: v.priceMinor, stock: v.stock })),
  }
}

async function routeData<T>(path: string, cookie?: string): Promise<T> {
  const res = await fetch(`${served.baseUrl}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  })
  const body = (await res.json()) as { data?: T }
  if (res.status !== 200) throw new Error(`GET ${path}: ${res.status} ${JSON.stringify(body)}`)
  return body.data as T
}

async function call(name: string, args: unknown): Promise<Answer> {
  const result = await tools.call(name, args, ANONYMOUS)
  return { isError: result.isError === true, payload: (result.structuredContent ?? {}) as Payload }
}

/** What the route lists, every page, in order. */
async function listedProducts(): Promise<RouteProduct[]> {
  const all: RouteProduct[] = []
  let cursor: string | null | undefined
  do {
    const page = await routeData<{ items: RouteProduct[]; nextCursor: string | null }>(
      `/api/products?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )
    all.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return all
}

const priced = (p: RouteProduct): boolean => p.priceRange !== null

function cartCount(): number {
  return committedCount(kernel.target, 'carts')
}

beforeAll(async () => {
  kernel = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(kernel)
  tag = randomUUID().slice(0, 8)
  brass = await seed(`Lantern ${tag} Brass`, [
    { priceMinor: 1250, stock: 20 },
    { priceMinor: 999, stock: 0 },
    { priceMinor: 4500, stock: 7 },
  ])
  pool = []
  for (let i = 0; i < 6; i += 1) {
    pool.push(
      await seed(`Lantern ${tag} Pool ${i}`, [
        { priceMinor: 100 + i * 37, stock: 40 },
        { priceMinor: 2999 + i * 101, stock: 40 },
      ]),
    )
  }
  scarce = await seed(`Lantern ${tag} Scarce`, [{ priceMinor: 700, stock: 3 }])
  empty = await seed(`Lantern ${tag} Empty`, [])
  bulk = await seed(`Lantern ${tag} Bulk`, [{ priceMinor: 250, stock: 200 }])
  const slugs = [brass, ...pool, scarce, empty, bulk].map((p) => p.slug)

  // The listing and the search index are projections: read until both hold every seeded product.
  await vi.waitFor(
    async () => {
      const listed = new Set((await listedProducts()).map((p) => p.slug))
      const missing = slugs.filter((slug) => !listed.has(slug))
      if (missing.length > 0) throw new Error(`not listed yet: ${missing.join(', ')}`)
      const found = await routeData<{ items: RouteProduct[] }>(
        `/api/products/search?q=${encodeURIComponent(brass.name)}&limit=100`,
      )
      if (!found.items.some((p) => p.slug === brass.slug)) throw new Error('not searchable yet')
    },
    { timeout: 15_000, interval: 50 },
  )

  const app = kernel.app
  const surface = createUcpSurface({
    mcp: toolSurface(app),
    variants: async (variantId: string) => {
      const variant = await kernel.store.read((tx) => kernel.repos.variant.findById(tx, variantId))
      if (variant === null) return null
      const product = await kernel.store.read((tx) =>
        kernel.repos.product.findById(tx, variant.productId),
      )
      return product?.slug ?? null
    },
    cart: (token: string) => kernel.services.cart.get(token),
    urls: () => ({ api: served.baseUrl, storefront: STOREFRONT }),
    links: LINKS,
  })
  if (surface.endpoint === undefined) throw new Error('the ucp surface has no endpoint')
  tools = surface.endpoint.tools
}, 60_000)

afterAll(async () => {
  await served?.stop()
})

/** The UCP products of a search answer against the route products they map, by slug. */
function expectMapped(products: UcpProduct[], route: RouteProduct[]): void {
  const bySlug = new Map(route.map((p) => [p.slug, p]))
  for (const product of products) {
    const source = bySlug.get(product.id)
    expect(source, `${product.id} is a route product`).not.toBeUndefined()
    const { priceRange, currency, variants } = source!
    expect(
      [product.price_range.min.amount, product.price_range.max.amount],
      `${product.id} price range`,
    ).toEqual([priceRange!.minMinor, priceRange!.maxMinor])
    expect([product.price_range.min.currency, product.price_range.max.currency]).toEqual([
      currency,
      currency,
    ])
    expect(product.variants.map((v) => v.id)).toEqual(variants.map((v) => v.id))
    for (const variant of product.variants) {
      const own = variants.find((v) => v.id === variant.id)!
      expect([variant.price.amount, variant.price.currency], variant.id).toEqual([
        own.priceMinor,
        currency,
      ])
      expect(variant.availability?.available, variant.id).toBe(own.stock > 0)
    }
  }
}

describe('AC-4: search_catalog answers what the catalogue routes answer, in UCP shape', () => {
  it("AC-4: a search for a product's name validates as a UCP search response whose product ids are the slugs GET /api/products/search answers, in order, with each price range, currency, variant id, variant price and availability the read model's", async () => {
    for (const query of [brass.name, empty.name, `Lantern ${tag}`]) {
      const answer = await call('search_catalog', {
        catalog: { query, pagination: { limit: 100 } },
      })
      const route = await routeData<{ items: RouteProduct[] }>(
        `/api/products/search?q=${encodeURIComponent(query)}&limit=100`,
      )
      const products = (answer.payload['products'] ?? []) as UcpProduct[]

      expect(answer.isError, query).toBe(false)
      expect(
        validateUcp('shopping/catalog_search.json#/$defs/search_response', answer.payload),
      ).toEqual([])
      expect(
        products.map((p) => p.id),
        query,
      ).toEqual(route.items.filter(priced).map((p) => p.slug))
      expect(products.map((p) => p.id)).not.toContain(empty.slug)
      expectMapped(products, route.items)
    }
    const found = await call('search_catalog', { catalog: { query: brass.name } })
    expect(((found.payload['products'] ?? []) as UcpProduct[]).map((p) => p.id)).toContain(
      brass.slug,
    )
  })

  it('AC-4: with no query the product ids follow GET /api/products, less any product with no price range', async () => {
    const answer = await call('search_catalog', { catalog: { pagination: { limit: 100 } } })
    const route = await routeData<{ items: RouteProduct[] }>('/api/products?limit=100')
    const products = (answer.payload['products'] ?? []) as UcpProduct[]

    expect(
      validateUcp('shopping/catalog_search.json#/$defs/search_response', answer.payload),
    ).toEqual([])
    expect(products.map((p) => p.id)).toEqual(route.items.filter(priced).map((p) => p.slug))
    expect(products.map((p) => p.id)).not.toContain(empty.slug)
    expectMapped(products, route.items)
  })

  it('AC-4: property: following pagination.cursor at any limit until has_next_page is false visits every listed product with a price range exactly once, and never the one without', async () => {
    const listed = (await listedProducts()).filter(priced).map((p) => p.slug)

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (limit) => {
        const seen: string[] = []
        let cursor: string | undefined
        for (let page = 0; page < 50; page += 1) {
          const answer = await call('search_catalog', {
            catalog: { pagination: { limit, ...(cursor !== undefined && { cursor }) } },
          })
          const products = (answer.payload['products'] ?? []) as UcpProduct[]
          const pagination = (answer.payload['pagination'] ?? { has_next_page: false }) as {
            has_next_page: boolean
            cursor?: string
          }
          expect(
            validateUcp('shopping/catalog_search.json#/$defs/search_response', answer.payload),
          ).toEqual([])
          expect(products.length).toBeLessThanOrEqual(limit)
          seen.push(...products.map((p) => p.id))
          if (!pagination.has_next_page) break
          cursor = pagination.cursor
        }

        expect(seen.length).toBe(new Set(seen).size)
        expect([...seen].sort()).toEqual([...listed].sort())
        expect(seen).not.toContain(empty.slug)
      }),
      { numRuns: 6, examples: [[2]] },
    )
  })
})

describe('AC-5: get_product and lookup_catalog resolve a product by its slug or any of its variant ids', () => {
  it('AC-5: get_product answers the same product for its slug and for each of its variant ids, as a UCP get_product response', async () => {
    const bySlug = await call('get_product', { catalog: { id: brass.slug } })
    const shape = (payload: Payload) => {
      const product = payload['product'] as UcpProduct
      return { id: product.id, title: product.title, variants: product.variants.map((v) => v.id) }
    }

    expect(bySlug.isError).toBe(false)
    expect(
      validateUcp('shopping/catalog_lookup.json#/$defs/get_product_response', bySlug.payload),
    ).toEqual([])
    expect(shape(bySlug.payload)).toEqual({
      id: brass.slug,
      title: brass.name,
      variants: brass.variants.map((v) => v.id),
    })
    for (const variant of brass.variants) {
      const byVariant = await call('get_product', { catalog: { id: variant.id } })
      expect(byVariant.isError, variant.id).toBe(false)
      expect(
        validateUcp('shopping/catalog_lookup.json#/$defs/get_product_response', byVariant.payload),
      ).toEqual([])
      expect(shape(byVariant.payload), variant.id).toEqual(shape(bySlug.payload))
    }
  })

  it("AC-5: lookup_catalog of a slug, a variant id of the same product and an unknown id answers that product once, its variants' inputs naming exactly the matched ids (exact for the variant id, featured for the slug), and one not_found message naming the unknown id", async () => {
    const variantId = brass.variants[2]!.id
    const answer = await call('lookup_catalog', {
      catalog: { ids: [brass.slug, variantId, 'nope'] },
    })
    const products = (answer.payload['products'] ?? []) as UcpProduct[]
    const inputs = products.flatMap((p) => p.variants.flatMap((v) => v.inputs ?? []))
    const notFound = (answer.payload.messages ?? []).filter((m) => m.code === 'not_found')

    expect(answer.isError).toBe(false)
    expect(
      validateUcp('shopping/catalog_lookup.json#/$defs/lookup_response', answer.payload),
    ).toEqual([])
    expect(products.map((p) => p.id)).toEqual([brass.slug])
    expect([...new Set(inputs.map((i) => i.id))].sort()).toEqual([brass.slug, variantId].sort())
    expect(products[0]!.variants.find((v) => v.id === variantId)?.inputs ?? []).toContainEqual(
      expect.objectContaining({ id: variantId, match: 'exact' }),
    )
    expect(inputs.filter((i) => i.id === brass.slug).map((i) => i.match)).toEqual(
      inputs.filter((i) => i.id === brass.slug).map(() => 'featured'),
    )
    expect(notFound).toHaveLength(1)
    expect(JSON.stringify(notFound[0])).toContain('nope')
  })

  it('AC-5: get_product of an unknown id, or of a product with no price range, answers a UCP error not_found with isError, and lookup_catalog leaves that product out', async () => {
    for (const id of [`nope-${randomUUID()}`, empty.slug]) {
      const answer = await call('get_product', { catalog: { id } })

      expect(answer.isError, id).toBe(true)
      expect(answer.payload.ucp?.status, id).toBe('error')
      expect(validateUcp('common/types/error_response.json', answer.payload), id).toEqual([])
      expect(
        (answer.payload.messages ?? []).map((m) => m.code),
        id,
      ).toContain('not_found')
    }
    const lookup = await call('lookup_catalog', { catalog: { ids: [empty.slug, brass.slug] } })
    expect(((lookup.payload['products'] ?? []) as UcpProduct[]).map((p) => p.id)).toEqual([
      brass.slug,
    ])
  })

  it('AC-5: lookup_catalog of 51 ids, or of an id over 200 characters, is refused before any product or variant read, where 50 ids up to 200 characters are read', async () => {
    const reads = { products: 0, variants: 0 }
    const app = toolSurface(kernel.app)
    const counted = createUcpSurface({
      mcp: {
        call: (name, args, caller) => {
          reads.products += 1
          return app.call(name, args, caller)
        },
      },
      variants: async () => {
        reads.variants += 1
        return null
      },
      cart: async () => null,
      urls: () => ({ api: served.baseUrl, storefront: STOREFRONT }),
      links: LINKS,
    }).endpoint!.tools
    const lookup = async (ids: string[]): Promise<boolean> => {
      try {
        return (
          (await counted.call('lookup_catalog', { catalog: { ids } }, ANONYMOUS)).isError === true
        )
      } catch {
        return true
      }
    }
    const longest = 'x'.repeat(200)

    const outcomes = {
      fiftyOne: await lookup(Array.from({ length: 51 }, () => brass.slug)),
      overLong: await lookup([`${longest}y`]),
    }
    const refusedReads = { ...reads }
    const fifty = await lookup([...Array.from({ length: 49 }, () => brass.slug), longest])

    expect(outcomes).toEqual({ fiftyOne: true, overLong: true })
    expect(refusedReads).toEqual({ products: 0, variants: 0 })
    expect(fifty).toBe(false)
    expect(reads.products).toBeGreaterThanOrEqual(50)
  })
})

interface CheckoutLine {
  id: string
  item: { id: string; title: string; price: number }
  quantity: number
  totals: Array<{ type: string; amount: number }>
}

interface Checkout {
  id: string
  status: string
  currency: string
  line_items: CheckoutLine[]
  totals: Array<{ type: string; amount: number }>
  messages: UcpMessage[]
  links: unknown
  expires_at: string
  continue_url: string
}

interface RouteCart {
  token: string
  items: Array<{ variantId: string; qty: number }>
  subtotalMinor: number
  expiresAt: string
}

const total = (totals: Array<{ type: string; amount: number }>, type: string): number[] =>
  totals.filter((t) => t.type === type).map((t) => t.amount)

describe('AC-6: create_checkout opens a cart of the lines asked for and hands the buyer to the store', () => {
  it('AC-6: property: for up to ten distinct in-stock variants at quantities 1-5 the checkout validates, requires escalation to continue_url, holds exactly those lines in the cart it names, totals the cart, matches get_checkout, and moves no stock and places no order', async () => {
    const variants = pool.flatMap((p) => p.variants)
    const priceOf = new Map(variants.map((v) => [v.id, v.priceMinor]))

    await fc.assert(
      fc.asyncProperty(
        fc
          .uniqueArray(fc.integer({ min: 0, max: variants.length - 1 }), {
            minLength: 1,
            maxLength: 10,
          })
          .chain((picks) =>
            fc.tuple(
              fc.constant(picks),
              fc.array(fc.integer({ min: 1, max: 5 }), {
                minLength: picks.length,
                maxLength: picks.length,
              }),
            ),
          ),
        async ([picks, quantities]) => {
          const wanted = picks.map((i, n) => ({ variantId: variants[i]!.id, qty: quantities[n]! }))
          const stockBefore = variants.map((v) => committedStock(kernel.target, v.id))
          const ordersBefore = committedCount(kernel.target, 'orders')

          const created = await call('create_checkout', {
            checkout: {
              line_items: wanted.map((w) => ({ item: { id: w.variantId }, quantity: w.qty })),
            },
          })
          const checkout = created.payload as unknown as Checkout
          const cart = await routeData<RouteCart>('/api/cart', `nymbal.cart=${checkout.id}`)
          const sum = wanted.reduce((acc, w) => acc + priceOf.get(w.variantId)! * w.qty, 0)
          const again = await call('get_checkout', { id: checkout.id })

          expect(created.isError).toBe(false)
          expect(validateUcp('shopping/checkout.json', checkout)).toEqual([])
          expect(checkout.status).toBe('requires_escalation')
          expect((checkout.messages ?? []).map((m) => m.severity)).toContain('requires_buyer_input')
          expect(checkout.continue_url).toBe(`${served.baseUrl}/api/agents/checkout/${checkout.id}`)
          expect(cart.token).toBe(checkout.id)
          expect(
            cart.items.map((i) => ({ variantId: i.variantId, qty: i.qty })).sort(byVariant),
          ).toEqual([...wanted].sort(byVariant))
          expect([
            ...total(checkout.totals ?? [], 'subtotal'),
            ...total(checkout.totals ?? [], 'total'),
          ]).toEqual([sum, sum])
          expect(cart.subtotalMinor).toBe(sum)
          for (const line of checkout.line_items ?? []) {
            const qty = wanted.find((w) => w.variantId === line.item.id)?.qty
            expect([line.id, line.quantity, line.item.price]).toEqual([
              line.item.id,
              qty,
              priceOf.get(line.item.id),
            ])
            expect(total(line.totals, 'subtotal')).toEqual([line.item.price * line.quantity])
          }
          expect((checkout.line_items ?? []).map((l) => l.item.id).sort()).toEqual(
            wanted.map((w) => w.variantId).sort(),
          )
          expect(checkout.expires_at).toBe(cart.expiresAt)
          expect(checkout.links).toEqual(LINKS)
          expect(again.isError).toBe(false)
          expect(again.payload).toEqual(created.payload)
          expect(variants.map((v) => committedStock(kernel.target, v.id))).toEqual(stockBefore)
          expect(committedCount(kernel.target, 'orders')).toBe(ordersBefore)
        },
      ),
      { numRuns: 12 },
    )
  }, 120_000)
})

function byVariant(a: { variantId: string }, b: { variantId: string }): number {
  return a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0
}

/** Whether a call was refused, as an isError result or a thrown protocol error. */
async function refused(name: string, args: unknown): Promise<boolean> {
  try {
    return (await tools.call(name, args, ANONYMOUS)).isError === true
  } catch {
    return true
  }
}

describe('AC-7: create_checkout refuses whole, and get_checkout reads only a live cart', () => {
  it('AC-7: an unknown variant, a line over its stock and a valid line answer a UCP error with not_found at line 0 and out_of_stock at line 1, recoverable, and no id or continue_url', async () => {
    const answer = await call('create_checkout', {
      checkout: {
        line_items: [
          { item: { id: randomUUID() }, quantity: 1 },
          { item: { id: scarce.variants[0]!.id }, quantity: scarce.variants[0]!.stock + 2 },
          { item: { id: pool[0]!.variants[0]!.id }, quantity: 1 },
        ],
      },
    })
    const messages = answer.payload.messages ?? []

    expect(answer.isError).toBe(true)
    expect(answer.payload.ucp?.status).toBe('error')
    expect(validateUcp('common/types/error_response.json', answer.payload)).toEqual([])
    expect(messages.map((m) => [m.code, m.path, m.severity])).toEqual([
      ['not_found', '$.checkout.line_items[0]', 'recoverable'],
      ['out_of_stock', '$.checkout.line_items[1]', 'recoverable'],
    ])
    expect(Object.keys(answer.payload)).not.toContain('id')
    expect(Object.keys(answer.payload)).not.toContain('continue_url')
  })

  it('AC-7: 51 lines, a quantity of 0 or 100, or a line with no item id is refused before any cart is opened, where 50 lines and a quantity of 99 are not', async () => {
    const id = bulk.variants[0]!.id
    const line = (quantity: number) => ({ item: { id }, quantity })
    const before = cartCount()

    const outcomes = {
      fiftyOne: await refused('create_checkout', {
        checkout: { line_items: Array.from({ length: 51 }, () => line(1)) },
      }),
      zero: await refused('create_checkout', { checkout: { line_items: [line(0)] } }),
      hundred: await refused('create_checkout', { checkout: { line_items: [line(100)] } }),
      noItemId: await refused('create_checkout', {
        checkout: { line_items: [{ item: {}, quantity: 1 }] },
      }),
    }
    const after = cartCount()
    const fifty = await call('create_checkout', {
      checkout: { line_items: Array.from({ length: 50 }, () => line(1)) },
    })
    const ninetyNine = await call('create_checkout', { checkout: { line_items: [line(99)] } })

    expect(outcomes).toEqual({ fiftyOne: true, zero: true, hundred: true, noItemId: true })
    expect(after).toBe(before)
    expect([fifty.isError, ninetyNine.isError]).toEqual([false, false])
    expect(cartCount()).toBe(before + 2)
  })

  it('AC-7: two lines of one variant answer one line of the summed quantity, and the cart holds the same', async () => {
    const id = pool[2]!.variants[1]!.id
    const answer = await call('create_checkout', {
      checkout: {
        line_items: [
          { item: { id }, quantity: 2 },
          { item: { id }, quantity: 3 },
        ],
      },
    })
    const checkout = answer.payload as unknown as Checkout
    const cart = await routeData<RouteCart>('/api/cart', `nymbal.cart=${checkout.id}`)

    expect((checkout.line_items ?? []).map((l) => [l.item.id, l.quantity])).toEqual([[id, 2 + 3]])
    expect(cart.items.map((i) => [i.variantId, i.qty])).toEqual([[id, 2 + 3]])
    expect(total(checkout.totals ?? [], 'total')).toEqual([pool[2]!.variants[1]!.priceMinor * 5])
  })

  it('AC-7: get_checkout of an unknown id or of an expired cart answers not_found with isError and opens no cart, where a live one answers its checkout', async () => {
    const live = await call('create_checkout', {
      checkout: { line_items: [{ item: { id: pool[3]!.variants[0]!.id }, quantity: 1 }] },
    })
    const liveId = (live.payload as unknown as Checkout).id
    const lapsed = await kernel.services.cart.getOrCreate()
    await unaudited(() =>
      kernel.store.transaction((tx) =>
        kernel.repos.cart.put(tx, {
          ...lapsed,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ),
    )
    const before = cartCount()

    const answers = await Promise.all(
      [randomUUID(), lapsed.token].map((id) => call('get_checkout', { id })),
    )
    const found = await call('get_checkout', { id: liveId })

    for (const answer of answers) {
      expect(answer.isError).toBe(true)
      expect(answer.payload.ucp?.status).toBe('error')
      expect((answer.payload.messages ?? []).map((m) => m.code)).toContain('not_found')
    }
    expect(cartCount()).toBe(before)
    expect([found.isError, (found.payload as unknown as Checkout).id]).toEqual([false, liveId])
  })
})
