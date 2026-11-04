import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiAdapter } from '@nymbalhq/types'
import { importDeps, openStoreApp, placeOrder, type StoreApp } from './support/store-app.js'
import { WC_URL } from './support/import-env.js'
import type { Rec, WooStore } from './support/woo-store.js'
import {
  CHANGED_AT,
  SINCE,
  imageFile,
  runOver,
  servedImage,
  simpleProduct,
  sinceForAll,
  stateOf,
  variation,
} from './support/woo-delta.js'

// What a delta writes to a product the import created, against whole stores built from the platform's dist through
// createApp on a SQLite file: never its stock or its variants, its media only when the images changed and all of them
// arrived, and never the copy AI enrichment wrote. Needs `pnpm build`.

afterEach(() => {
  vi.unstubAllGlobals()
})

const PRODUCTS: Array<'categories' | 'products'> = ['categories', 'products']

const empty = (products: Rec[], variations: Record<number, Rec[]> = {}): WooStore => ({
  categories: [],
  products,
  variations,
  customers: [],
  orders: [],
  reviews: [],
})

async function productOf(env: StoreApp, wcId: number) {
  const id = (await stateOf(env)).wcToNymbalProduct[wcId]
  if (id === undefined) throw new Error(`product ${wcId} was not imported`)
  return env.app.services.product.getById(id)
}

const lastSeq = (env: StoreApp): number =>
  env.rows<{ s: number | null }>('SELECT max(seq) AS s FROM events')[0]!.s ?? 0

function updatedSince(env: StoreApp, seq: number): string[] {
  return env
    .rows<{
      id: string
    }>(
      `SELECT json_extract(envelope, '$.payload.product.id') AS id FROM events WHERE type = 'product.updated.v1' AND seq > ?`,
      seq,
    )
    .map((r) => r.id)
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `token` in `text` as a whole word: `V-1001` is not in `V-10011`. */
const mentions = (text: string, token: string) =>
  new RegExp(`(?<![\\w-])${escape(token)}(?![\\w-])`).test(text)

type Warning = { phase: string; id?: string; message: string }

/** The warnings that name the product by its WooCommerce id (in `id`, else in the message) and, when given, the SKU. */
const naming = (warnings: Warning[], wcId: number, sku?: string) =>
  warnings.filter(
    (w) =>
      (w.id !== undefined ? w.id === String(wcId) : mentions(w.message, String(wcId))) &&
      (sku === undefined || mentions(w.message, sku)),
  )

// ── AC-7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface VariableDraft {
  prices: number[]
  stock: number[]
  bumps: number[]
}

const variableDraft: fc.Arbitrary<VariableDraft> = fc.record({
  prices: fc.array(fc.integer({ min: 100, max: 50_000 }), { minLength: 2, maxLength: 3 }),
  stock: fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 3, maxLength: 3 }),
  bumps: fc.array(fc.integer({ min: 1, max: 5_000 }), { minLength: 3, maxLength: 3 }),
})

/** Product 1 gains a variation and loses one, product 2 turns simple, every other is only repriced. */
const stockSources = fc.record({
  drafts: fc.array(variableDraft, { minLength: 3, maxLength: 5 }),
  stockMove: fc.integer({ min: -40, max: 40 }).filter((n) => n !== 0),
})

const money = (cents: number) => (cents / 100).toFixed(2)
const vid = (wcId: number, n: number) => wcId * 1_000 + n

function variableProduct(wcId: number, variationIds: number[], over: Rec = {}): Rec {
  return simpleProduct(wcId, { type: 'variable', variations: variationIds, ...over })
}

interface StockCase {
  a: WooStore
  b: WooStore
  added: { wcId: number; sku: string }
  removed: { wcId: number; sku: string }
  retyped: number
  /** Each variation present in both sources, its SKU and its new price in minor units. */
  repriced: Array<{ wcId: number; sku: string; priceMinor: number }>
}

function stockCase(drafts: VariableDraft[], stockMove: number): StockCase {
  const aProducts: Rec[] = []
  const bProducts: Rec[] = []
  const aVariations: Record<number, Rec[]> = {}
  const bVariations: Record<number, Rec[]> = {}
  const repriced: StockCase['repriced'] = []
  drafts.forEach((d, i) => {
    const wcId = i + 1
    const own = d.prices.map((cents, n) =>
      variation(vid(wcId, n), { regular_price: money(cents), stock_quantity: d.stock[n] }),
    )
    aVariations[wcId] = own
    aProducts.push(
      variableProduct(
        wcId,
        own.map((v) => v['id'] as number),
      ),
    )
    if (wcId === 2) {
      bProducts.push(
        simpleProduct(wcId, {
          date_modified_gmt: CHANGED_AT,
          regular_price: money(d.prices[0]! + 1),
        }),
      )
      return
    }
    let next: Rec[] = own.map((v, n) => ({
      ...v,
      regular_price: money(d.prices[n]! + d.bumps[n]!),
      stock_quantity: Math.max(0, (v['stock_quantity'] as number) + stockMove),
    }))
    if (wcId === 1) {
      next = [
        ...next.slice(1),
        variation(vid(wcId, 9), { regular_price: '9.99', stock_quantity: 3 }),
      ]
    }
    for (const v of next) {
      const n = (v['id'] as number) - wcId * 1_000
      if (n === 9) continue
      repriced.push({ wcId, sku: v['sku'] as string, priceMinor: d.prices[n]! + d.bumps[n]! })
    }
    bVariations[wcId] = next
    bProducts.push(
      variableProduct(
        wcId,
        next.map((v) => v['id'] as number),
        { date_modified_gmt: CHANGED_AT },
      ),
    )
  })
  return {
    a: empty(aProducts, aVariations),
    b: empty(bProducts, bVariations),
    added: { wcId: 1, sku: `V-${vid(1, 9)}` },
    removed: { wcId: 1, sku: `V-${vid(1, 0)}` },
    retyped: 2,
    repriced,
  }
}

const stockRows = (env: StoreApp) => ({
  variants: env.rows('SELECT id, product_id, sku, stock FROM variants ORDER BY id'),
  adjustments: env.rows('SELECT * FROM stock_adjustments ORDER BY id'),
  reservations: env.rows('SELECT * FROM inventory_reservations ORDER BY reservation_id'),
})

describe('AC-7: a delta moves no stock and applies only matched variants', () => {
  it('AC-7: with stock changed, a variation added, one removed and a product turned simple, every variant’s stock and every stock_adjustments and inventory_reservations row are as before, no variant is added or removed, each added, removed or retyped item is one warning naming the product and the SKU, and the matched variants take their new prices', async () => {
    await fc.assert(
      fc.asyncProperty(stockSources, async ({ drafts, stockMove }) => {
        const c = stockCase(drafts, stockMove)
        const env = await openStoreApp()
        try {
          await runOver(env, { store: c.a, entities: PRODUCTS })
          // A checkout holds stock on an imported variant: a reservation the delta must leave alone.
          const held = await productOf(env, 3)
          await placeOrder(env, held.id, held.variants[0]!.id)
          await env.app.relay.drain()
          const before = stockRows(env)

          const { report } = await runOver(env, {
            store: c.b,
            entities: PRODUCTS,
            since: sinceForAll(SINCE),
          })

          const prices = await Promise.all(
            c.repriced.map(async (r) => {
              const p = await productOf(env, r.wcId)
              return [r.sku, p.variants.find((v) => v.sku === r.sku)?.priceMinor]
            }),
          )
          expect(prices).toEqual(c.repriced.map((r) => [r.sku, r.priceMinor]))
          expect(stockRows(env)).toEqual(before)
          const warnings: Warning[] = report!.warnings ?? []
          expect([
            naming(warnings, c.added.wcId, c.added.sku).length,
            naming(warnings, c.removed.wcId, c.removed.sku).length,
            naming(warnings, c.retyped).length,
            warnings.length,
          ]).toEqual([1, 1, 1, 3])
        } finally {
          await env.close()
        }
      }),
      { numRuns: 10 },
    )
  }, 600_000)

  it('AC-7: a product whose slug the import suffixed (two products share a raw slug) and whose variants have no SKU, re-listed alone, has its variants matched: prices applied, no warning, no variant added or removed', async () => {
    const env = await openStoreApp()
    try {
      const twins = [11, 12].map((wcId) =>
        variableProduct(wcId, [vid(wcId, 0), vid(wcId, 1)], { slug: 'twin', sku: '' }),
      )
      const variations = Object.fromEntries(
        [11, 12].map((wcId) => [
          wcId,
          [0, 1].map((n) => variation(vid(wcId, n), { sku: '', regular_price: '10.00' })),
        ]),
      )
      await runOver(env, { store: empty(twins, variations), entities: PRODUCTS })
      const before = await productOf(env, 12)
      const b = empty([{ ...twins[1]!, date_modified_gmt: CHANGED_AT }, twins[0]!], {
        ...variations,
        12: variations[12]!.map((v) => ({ ...v, regular_price: '14.50' })),
      })

      const { report } = await runOver(env, {
        store: b,
        entities: PRODUCTS,
        since: sinceForAll(SINCE),
      })

      const after = await productOf(env, 12)
      expect(after.variants.map((v) => [v.id, v.priceMinor])).toEqual(
        before.variants.map((v) => [v.id, 1450]),
      )
      expect(naming(report!.warnings ?? [], 12)).toEqual([])
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-7: a changed variable product whose variations cannot be read is one products error naming it, with no type warning, its prices and copy as stored, and the other products applied', async () => {
    const env = await openStoreApp()
    try {
      const own = [0, 1].map((n) => variation(vid(1, n), { regular_price: '10.00' }))
      const a = empty([variableProduct(1, [vid(1, 0), vid(1, 1)]), simpleProduct(2)], { 1: own })
      const imported = (await runOver(env, { store: a, entities: PRODUCTS })).report!
      const before = await productOf(env, 1)
      const b = empty(
        [
          {
            ...a.products[0]!,
            name: 'variable renamed',
            description: 'new words',
            date_modified_gmt: CHANGED_AT,
          },
          { ...a.products[1]!, name: 'product 2 renamed', date_modified_gmt: CHANGED_AT },
        ],
        { 1: own.map((v) => ({ ...v, regular_price: '19.00' })) },
      )

      const { report } = await runOver(env, {
        store: b,
        entities: PRODUCTS,
        since: sinceForAll(SINCE),
        fail: (u) => u.pathname.endsWith('/products/1/variations'),
      })

      const added = report!.errors.slice(imported.errors.length)
      expect(added.map((e) => [e.phase, e.id])).toEqual([['products', '1']])
      expect(naming(report!.warnings ?? [], 1)).toEqual([])
      const kept = (p: typeof before) => ({
        name: p.name,
        description: p.description,
        type: p.type,
        prices: p.variants.map((v) => [v.id, v.priceMinor, v.compareAtPriceMinor]),
      })
      expect(kept(await productOf(env, 1))).toEqual(kept(before))
      expect((await productOf(env, 2)).name).toBe('product 2 renamed')
      expect(report!.updated?.products).toBe(1)
    } finally {
      await env.close()
    }
  }, 120_000)
})

// ── AC-8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Product 2 shares product 1's raw slug, so the import stored its images under `twin-2`. */
function imageSource(): WooStore {
  return empty([
    simpleProduct(1, { slug: 'twin', images: [servedImage('1-a', 'first of one')] }),
    simpleProduct(2, {
      slug: 'twin',
      images: [servedImage('2-a', 'first'), servedImage('2-b', 'second')],
    }),
  ])
}

/** The source with product 2 changed as `over` says and listed alone. */
function relisted(a: WooStore, over: Rec): WooStore {
  return {
    ...a,
    products: a.products.map((p) =>
      p['id'] === 2 ? { ...p, ...over, date_modified_gmt: CHANGED_AT } : p,
    ),
  }
}

describe('AC-8: images in a delta', () => {
  it('AC-8: a re-listed product whose images are unchanged takes its new name with no image request and its media as it was', async () => {
    const env = await openStoreApp()
    try {
      const a = imageSource()
      await runOver(env, { store: a, entities: PRODUCTS })
      const before = await productOf(env, 2)

      const { requests } = await runOver(env, {
        store: relisted(a, { name: 'second twin, renamed' }),
        entities: PRODUCTS,
        since: sinceForAll(SINCE),
      })

      const after = await productOf(env, 2)
      expect(after.name).toBe('second twin, renamed')
      expect(requests.filter((r) => r.path.startsWith('/img/')).map((r) => r.path)).toEqual([])
      expect(after.media).toEqual(before.media)
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-8: a product whose image list changed gets the new images, in order with their alt text, under its stored slug', async () => {
    const env = await openStoreApp()
    try {
      const a = imageSource()
      await runOver(env, { store: a, entities: PRODUCTS })
      const before = await productOf(env, 2)
      const images = [servedImage('2-b', 'second, now first'), servedImage('2-c', 'third')]

      await runOver(env, {
        store: relisted(a, { images }),
        entities: PRODUCTS,
        since: sinceForAll(SINCE),
      })

      const after = await productOf(env, 2)
      expect(
        after.media.map((m) => ({ url: m.url, altText: m.altText, position: m.position })),
      ).toEqual(
        images.map((img, position) => ({
          url: `/imported-media/products/${before.slug}/${imageFile(img['src'] as string)}`,
          altText: img['alt'],
          position,
        })),
      )
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-8: a product whose new image fails to download keeps its stored media, and the delta reports one products error naming it, the image and why', async () => {
    const env = await openStoreApp()
    try {
      const a = imageSource()
      const imported = (await runOver(env, { store: a, entities: PRODUCTS })).report!
      const before = await productOf(env, 2)
      const images = [
        servedImage('2-a', 'first'),
        { id: 0, src: `${WC_URL}/gone/2-x.jpg`, name: '2-x', alt: 'never arrives' },
      ]

      const { report } = await runOver(env, {
        store: relisted(a, { images }),
        entities: PRODUCTS,
        since: sinceForAll(SINCE),
      })

      const added = report!.errors.slice(imported.errors.length)
      expect(added.map((e) => [e.phase, e.id])).toEqual([['products', '2']])
      expect(added[0]!.error).toContain(`${images[1]!.src} (HTTP 404)`)
      expect((await productOf(env, 2)).media).toEqual(before.media)
    } finally {
      await env.close()
    }
  }, 120_000)
})

// ── AC-9 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An AI adapter answering every enrichment prompt with short copy naming the product, and the names it was asked for. */
function aiStandIn() {
  const asked: string[] = []
  const ai = {
    kind: 'ai',
    async complete(prompt: string) {
      const name = /Product name: (.*)/.exec(prompt)?.[1] ?? ''
      asked.push(name)
      return JSON.stringify({
        description: `ai copy for ${name}`,
        shortDescription: `ai short for ${name}`,
        seoTitle: `ai title for ${name}`,
        seoDescription: `ai seo for ${name}`,
      })
    },
  } as unknown as AiAdapter
  return { ai, asked }
}

describe('AC-9: enriched products in a delta', () => {
  it('AC-9: an enriched product re-listed with a new name and description keeps its AI copy and enriched metadata and takes the name; one re-listed unchanged is not written; the AI is asked only about the product the delta created', async () => {
    const env = await openStoreApp()
    try {
      const { ai, asked } = aiStandIn()
      const deps = { ...importDeps(env), adapters: { ai, reviews: env.app.adapters.reviews } }
      const a = empty([simpleProduct(1), simpleProduct(2)])
      await runOver(env, { store: a, entities: PRODUCTS, ai: true }, deps)
      const enriched = await productOf(env, 1)
      const askedAtImport = asked.length
      const seq = lastSeq(env)
      const b = empty([
        {
          ...a.products[0]!,
          name: 'product 1 renamed',
          description: 'new words',
          date_modified_gmt: CHANGED_AT,
        },
        { ...a.products[1]!, date_modified_gmt: CHANGED_AT },
        simpleProduct(3, { date_modified_gmt: CHANGED_AT }),
      ])

      const { report } = await runOver(
        env,
        { store: b, entities: PRODUCTS, ai: true, since: sinceForAll(SINCE) },
        deps,
      )

      const after = await productOf(env, 1)
      const copy = (p: typeof after) => ({
        description: p.description,
        shortDescription: p.shortDescription,
        seoTitle: p.seoTitle,
        seoDescription: p.seoDescription,
        enriched: (p.metadata['woocommerce'] as { enriched?: unknown } | undefined)?.enriched,
      })
      expect(after.name).toBe('product 1 renamed')
      expect(copy(after)).toEqual(copy(enriched))
      expect(asked.slice(askedAtImport)).toEqual(['product 3'])
      expect((await productOf(env, 3)).description).toBe('ai copy for product 3')
      await env.app.relay.drain()
      const unchangedId = (await productOf(env, 2)).id
      expect(updatedSince(env, seq).filter((id) => id === unchangedId)).toEqual([])
      expect(report!.updated?.products).toBe(1)
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-9: a delta stopped after its first products page and resumed enriches every product the pass created, each once, and no other', async () => {
    const env = await openStoreApp()
    try {
      const { ai, asked } = aiStandIn()
      const deps = { ...importDeps(env), adapters: { ai, reviews: env.app.adapters.reviews } }
      const a = empty([simpleProduct(1), simpleProduct(2)])
      await runOver(env, { store: a, entities: PRODUCTS, ai: true }, deps)
      const askedAtImport = asked.length
      // Page 1 holds the two re-listed products and 98 new ones; the other 32 new ones are on page 2.
      const created = Array.from({ length: 130 }, (_, i) => 101 + i)
      const b = empty([
        ...a.products.map((p) => ({
          ...p,
          name: `${String(p['name'])} renamed`,
          date_modified_gmt: CHANGED_AT,
        })),
        ...created.map((id) => simpleProduct(id, { date_modified_gmt: CHANGED_AT })),
      ])

      await runOver(
        env,
        {
          store: b,
          entities: PRODUCTS,
          ai: true,
          since: sinceForAll(SINCE),
          hold: (u) => u.pathname.endsWith('/products') && u.searchParams.get('page') === '2',
        },
        deps,
      )
      const { report } = await runOver(env, { store: b, entities: PRODUCTS, ai: true }, deps)

      expect(asked.slice(askedAtImport).sort()).toEqual(created.map((id) => `product ${id}`).sort())
      expect(report!.enriched.enriched).toBe(created.length)
    } finally {
      await env.close()
    }
  }, 300_000)
})
