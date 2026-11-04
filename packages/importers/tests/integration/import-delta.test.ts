import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rollbackImport, type ImportEntity } from '@nymbalhq/importers'
import {
  ALL_ENTITIES,
  openStoreApp,
  seedStore,
  type StoreApp,
  type TableSnapshot,
} from './support/store-app.js'
import { arbStore, fixtureStore, type Rec, type WooStore } from './support/woo-store.js'
import {
  CHANGED_AT,
  SINCE,
  category,
  customer,
  dateParams,
  order,
  resourceOf,
  review,
  runOver,
  simpleProduct,
  sinceForAll,
  stateOf,
} from './support/woo-delta.js'

// `runWooCommerceImport` with `since` after an import, against whole stores built from the platform's dist through
// createApp on a SQLite file, the source served as WooCommerce lists what changed after a date. Needs `pnpm build`.

afterEach(() => {
  vi.unstubAllGlobals()
})

const PRODUCT_UPDATED = 'product.updated.v1'
/** The reviews `after` a delta from SINCE sends: a day earlier, read without a zone. */
const REVIEWS_AFTER = '2026-09-30T00:00:00'

/** Rows each entity's table holds. */
function entityRows(env: StoreApp): Record<ImportEntity, number> {
  const count = (table: string) =>
    env.rows<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]!.n
  return {
    categories: count('categories'),
    products: count('products'),
    customers: count('customers'),
    orders: count('orders'),
    reviews: count('reviews'),
  }
}

const MAP_OF = {
  categories: 'wcToNymbalCategory',
  products: 'wcToNymbalProduct',
  customers: 'wcToNymbalCustomer',
  orders: 'wcToNymbalOrder',
  reviews: 'wcToNymbalReview',
} as const

const lastSeq = (env: StoreApp): number =>
  env.rows<{ s: number | null }>('SELECT max(seq) AS s FROM events')[0]!.s ?? 0

/** The product ids of every `product.updated.v1` published after `seq`, one entry per event. */
function updatedSince(env: StoreApp, seq: number): string[] {
  return env
    .rows<{
      id: string
    }>(`SELECT json_extract(envelope, '$.payload.product.id') AS id FROM events WHERE type = ? AND seq > ? ORDER BY seq`, PRODUCT_UPDATED, seq)
    .map((r) => r.id)
}

function expectTablesAsBefore(before: TableSnapshot, after: TableSnapshot): void {
  expect(Object.keys(after)).toEqual(Object.keys(before))
  for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table])
}

/** A product as Decision 4 compares it, its ids read back as WooCommerce ids; slug, ids and `syncedAt` aside. */
async function productFields(env: StoreApp, wcId: number) {
  const state = await stateOf(env)
  const id = state.wcToNymbalProduct[wcId]
  if (id === undefined) return null
  const p = await env.app.services.product.getById(id)
  const wcCategory = Object.fromEntries(
    Object.entries(state.wcToNymbalCategory).map(([wc, nymbal]) => [nymbal, Number(wc)]),
  )
  const { syncedAt: _syncedAt, ...woocommerce } = (p.metadata['woocommerce'] ?? {}) as Rec
  return {
    name: p.name,
    description: p.description,
    shortDescription: p.shortDescription,
    status: p.status,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    categories: p.categoryIds.map((c) => wcCategory[c] ?? c).sort(),
    // The path holds the slug; the file name is the image.
    media: [...p.media]
      .sort((a, b) => a.position - b.position)
      .map((m) => ({ file: m.url.split('/').at(-1), altText: m.altText })),
    variants: [...p.variants]
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map((v) => ({
        sku: v.sku,
        priceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor,
      })),
    woocommerce,
  }
}

/** A product's own row and its variants' and category links' rows, as stored. */
function productRows(env: StoreApp, id: string) {
  return {
    product: env.rows('SELECT * FROM products WHERE id = ?', id),
    variants: env.rows('SELECT * FROM variants WHERE product_id = ? ORDER BY id', id),
    categories: env.rows(
      'SELECT * FROM product_categories WHERE product_id = ? ORDER BY category_id',
      id,
    ),
  }
}

// ── Sources ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Descriptions with a raw ampersand and two entities, which the store keeps in its own sanitized form. */
const description = (name: unknown, word: string) => `${word} ${String(name)} & co&nbsp;it&#8217;s`

/** `s` with every slug, SKU, email and order number its own, and a description as the store re-encodes it. */
function ownValues(s: WooStore): WooStore {
  return {
    ...s,
    categories: s.categories.map((c) => ({ ...c, slug: `cat-${String(c['id'])}` })),
    products: s.products.map((p) => ({
      ...p,
      slug: `p-${String(p['id'])}`,
      sku: `SKU-${String(p['id'])}`,
      description: description(p['name'], 'about'),
    })),
    variations: Object.fromEntries(
      Object.entries(s.variations).map(([id, vs]) => [
        id,
        vs.map((v) => ({ ...v, sku: `V-${String(v['id'])}` })),
      ]),
    ),
    customers: s.customers.map((c) => {
      const email = `c${String(c['id'])}@example.com`
      return { ...c, email, billing: { ...(c['billing'] as Rec), email } }
    }),
    orders: s.orders.map((o) => ({ ...o, number: String(o['id']) })),
  }
}

/** `s` with every id moved by `by` (references too), dated as changed after any `since`: records new to a delta. */
function shifted(s: WooStore, by: number): WooStore {
  const id = (r: Rec) => (r['id'] as number) + by
  return ownValues({
    categories: s.categories.map((c) => ({
      ...c,
      id: id(c),
      parent: (c['parent'] as number) > 0 ? (c['parent'] as number) + by : 0,
    })),
    products: s.products.map((p) => ({
      ...p,
      id: id(p),
      date_modified_gmt: CHANGED_AT,
      categories: (p['categories'] as Rec[]).map((c) => ({ ...c, id: id(c) })),
      variations: (p['variations'] as number[]).map((v) => v + by),
    })),
    variations: Object.fromEntries(
      Object.entries(s.variations).map(([pid, vs]) => [
        Number(pid) + by,
        vs.map((v) => ({ ...v, id: id(v) })),
      ]),
    ),
    customers: s.customers.map((c) => ({ ...c, id: id(c) })),
    orders: s.orders.map((o) => ({
      ...o,
      id: id(o),
      date_modified_gmt: CHANGED_AT,
      customer_id: (o['customer_id'] as number) > 0 ? (o['customer_id'] as number) + by : 0,
      line_items: (o['line_items'] as Rec[]).map((l) => ({
        ...l,
        product_id: (l['product_id'] as number) + by,
      })),
    })),
    reviews: s.reviews.map((r) => ({
      ...r,
      id: id(r),
      product_id: (r['product_id'] as number) + by,
      date_created_gmt: CHANGED_AT,
    })),
  })
}

type Change = 'name' | 'description' | 'status' | 'category' | 'price'
type Plan = { kind: 'changed'; changes: Change[] } | { kind: 'relisted' } | { kind: 'unlisted' }

const planArb: fc.Arbitrary<Plan> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc
      .subarray<Change>(['name', 'description', 'status', 'category', 'price'], { minLength: 1 })
      .map((changes) => ({ kind: 'changed' as const, changes })),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'relisted' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'unlisted' as const }) },
)

/** WooCommerce id of the new product that shares the raw slug of the first imported product, which is never listed. */
const SLUG_TWIN = 20_000
const NEW_CATEGORY = 9_000
const NEW_CUSTOMER = 30_000
const NEW_ORDER = 70_000
const NEW_REVIEW = 30_000

const cents = (price: unknown) => Math.round(parseFloat(String(price)) * 100)
const plusOne = (price: unknown) => ((cents(price) + 100) / 100).toFixed(2)

/** An item's prices one unit up: an item on sale keeps charging its sale price, any other its new regular price. */
const repriced = (item: Rec): Rec => ({
  regular_price: plusOne(item['regular_price']),
  ...(item['on_sale'] !== true && { price: plusOne(item['regular_price']) }),
})

interface Changed {
  source: WooStore
  changed: number[]
  unchanged: number[]
}

/**
 * The source after the import: products changed as `plans` say (the first product is never listed), new records of
 * every entity, and a new product whose raw slug is the first product's unless `twinSlug` says otherwise.
 */
function changedSource(
  a: WooStore,
  extra: WooStore,
  plans: Plan[],
  twinSlug: unknown = a.products[0]!['slug'],
): Changed {
  const variations: Record<number, Rec[]> = Object.fromEntries(
    Object.entries(a.variations).map(([pid, vs]) => [pid, vs.map((v) => ({ ...v }))]),
  )
  const changed: number[] = []
  const unchanged: number[] = []
  const products = a.products.map((p, i) => {
    const wcId = p['id'] as number
    const drawn: Plan = i === 0 ? { kind: 'unlisted' } : plans[i]!
    // A variable product with no variations is not for sale and imports as a draft whatever its status, with no
    // price of its own: a change to either is no change to the store.
    const forSale = p['type'] !== 'variable' || (variations[wcId]?.length ?? 0) > 0
    const changes =
      drawn.kind === 'changed'
        ? drawn.changes.filter((c) => forSale || (c !== 'status' && c !== 'price'))
        : []
    const plan: Plan =
      drawn.kind === 'changed' && changes.length === 0 ? { kind: 'relisted' } : drawn
    if (plan.kind === 'unlisted') {
      unchanged.push(wcId)
      return p
    }
    if (plan.kind === 'relisted') {
      unchanged.push(wcId)
      return { ...p, date_modified_gmt: CHANGED_AT }
    }
    changed.push(wcId)
    const next: Rec = { ...p, date_modified_gmt: CHANGED_AT }
    for (const change of changes) {
      if (change === 'name') next['name'] = `${String(p['name'])} renamed`
      if (change === 'description') next['description'] = description(p['name'], 'revised')
      if (change === 'status') next['status'] = p['status'] === 'publish' ? 'draft' : 'publish'
      if (change === 'category') {
        next['categories'] = [{ id: NEW_CATEGORY, name: 'delta cat', slug: 'delta-cat' }]
      }
      if (change === 'price') {
        const own = variations[wcId]
        if (p['type'] === 'variable' && own !== undefined && own.length > 0) {
          own[0] = { ...own[0]!, ...repriced(own[0]!) }
        } else {
          Object.assign(next, repriced(p))
        }
      }
    }
    return next
  })
  const twin = simpleProduct(SLUG_TWIN, {
    slug: twinSlug,
    date_modified_gmt: CHANGED_AT,
  })
  return {
    changed,
    unchanged,
    source: {
      categories: [
        ...a.categories,
        ...extra.categories,
        category(NEW_CATEGORY, { name: 'delta cat', slug: 'delta-cat' }),
      ],
      products: [...products, ...extra.products, twin],
      variations: { ...variations, ...extra.variations },
      customers: [...a.customers, ...extra.customers, customer(NEW_CUSTOMER)],
      orders: [
        ...a.orders,
        ...extra.orders,
        order(NEW_ORDER, SLUG_TWIN, NEW_CUSTOMER, { date_modified_gmt: CHANGED_AT }),
      ],
      reviews: [
        ...a.reviews,
        ...extra.reviews,
        review(NEW_REVIEW, SLUG_TWIN, { date_created_gmt: CHANGED_AT }),
      ],
    },
  }
}

const imported = (sizes: { products: number }) =>
  arbStore({
    products: fc.integer({ min: 2, max: sizes.products }),
    categories: 3,
    customers: 3,
    orders: 3,
    reviews: 3,
  })
const extras = arbStore({
  products: fc.integer({ min: 0, max: 2 }),
  categories: 2,
  customers: 2,
  orders: 2,
  reviews: 2,
}).map((s) => shifted(s, 10_000))

/** An imported source, the records new to the delta, and what happens to each imported product. */
const deltas = (base: fc.Arbitrary<WooStore>) =>
  fc
    .tuple(base, extras)
    .chain(([a, extra]) =>
      fc.tuple(
        fc.constant(a),
        fc.constant(extra),
        fc.array(planArb, { minLength: a.products.length, maxLength: a.products.length }),
      ),
    )

// ── AC-1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The fixture store with two old reviews, everything dated before SINCE. */
function fixtureWithReviews(): WooStore {
  return fixtureStore({ reviews: [review(1, 100), review(2, 101)] })
}

describe('AC-1: a delta asks each endpoint only for what it can filter', () => {
  it('AC-1: products and orders carry modified_after and dates_are_gmt=true, reviews carry after a day earlier without dates_are_gmt, and categories, customers and a changed product’s variations carry none of the three', async () => {
    const env = await openStoreApp()
    try {
      const a = fixtureWithReviews()
      await runOver(env, { store: a })
      const b: WooStore = {
        ...a,
        products: a.products.map((p) =>
          p['id'] === 101
            ? { ...p, name: 'graphic logo tee, renamed', date_modified_gmt: CHANGED_AT }
            : { ...p, date_modified_gmt: CHANGED_AT },
        ),
        orders: a.orders.map((o) => ({ ...o, date_modified_gmt: CHANGED_AT })),
        reviews: [...a.reviews, review(3, 100, { date_created_gmt: CHANGED_AT })],
      }

      const { requests } = await runOver(env, { store: b, since: sinceForAll(SINCE) })

      // The connect check and the store settings are read before any list, and no delta filters them.
      const api = requests.filter((r) => {
        const resource = resourceOf(r)
        return resource !== null && resource !== '/system_status' && !resource.startsWith('/settings/')
      })
      expect([...new Set(api.map(resourceOf))].sort()).toEqual(
        [
          '/customers',
          '/orders',
          '/products',
          '/products/:id/variations',
          '/products/categories',
          '/products/reviews',
        ].sort(),
      )
      type Params = ReturnType<typeof dateParams>
      const none: Params = { modified_after: null, after: null, dates_are_gmt: null }
      const expected: Record<string, Params> = {
        '/products': { modified_after: SINCE, after: null, dates_are_gmt: 'true' },
        '/orders': { modified_after: SINCE, after: null, dates_are_gmt: 'true' },
        '/products/reviews': { modified_after: null, after: REVIEWS_AFTER, dates_are_gmt: null },
        '/products/categories': none,
        '/customers': none,
        '/products/:id/variations': none,
      }
      const sent = api.map((r) => {
        const p = dateParams(r)
        return { resource: resourceOf(r), ...p, after: p.after?.replace(/Z$/, '') ?? null }
      })
      expect(sent).toEqual(
        api.map((r) => ({ resource: resourceOf(r), ...expected[resourceOf(r)!] })),
      )
    } finally {
      await env.close()
    }
  }, 120_000)
})

// ── AC-2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-2: a delta brings the store to what an import of the changed source gives', () => {
  it('AC-2: for generated sources, each product equals on Decision 4’s fields what an import of the changed source into an empty store gives, each new record is created once (the slug twin suffixed as the import suffixes it), an unchanged product’s rows are untouched, and product.updated.v1 is published once per changed product and never for another', async () => {
    await fc.assert(
      fc.asyncProperty(
        deltas(imported({ products: 5 }).map(ownValues)),
        async ([a, extra, plans]) => {
          const { source: b, changed, unchanged } = changedSource(a, extra, plans)

          const fresh = await openStoreApp()
          let freshRows: Record<ImportEntity, number>
          let freshMaps: Record<ImportEntity, string[]>
          const freshProducts = new Map<number, Awaited<ReturnType<typeof productFields>>>()
          let twinSlug: string
          try {
            await runOver(fresh, { store: b })
            freshRows = entityRows(fresh)
            const state = await stateOf(fresh)
            freshMaps = Object.fromEntries(
              ALL_ENTITIES.map((e) => [e, Object.keys(state[MAP_OF[e]]).sort()]),
            ) as Record<ImportEntity, string[]>
            for (const p of b.products) {
              freshProducts.set(p['id'] as number, await productFields(fresh, p['id'] as number))
            }
            twinSlug = (
              await fresh.app.services.product.getById(state.wcToNymbalProduct[SLUG_TWIN]!)
            ).slug
          } finally {
            await fresh.close()
          }

          const env = await openStoreApp()
          try {
            await runOver(env, { store: a })
            const before = await stateOf(env)
            const untouched = unchanged
              .map((wcId) => before.wcToNymbalProduct[wcId])
              .filter((id): id is string => id !== undefined)
            const rowsBefore = untouched.map((id) => productRows(env, id))
            const seq = lastSeq(env)

            await runOver(env, { store: b, since: sinceForAll(SINCE) })

            expect(entityRows(env)).toEqual(freshRows)
            const after = await stateOf(env)
            expect(
              Object.fromEntries(
                ALL_ENTITIES.map((e) => [e, Object.keys(after[MAP_OF[e]]).sort()]),
              ),
            ).toEqual(freshMaps)
            for (const p of b.products) {
              const wcId = p['id'] as number
              expect([wcId, await productFields(env, wcId)]).toEqual([
                wcId,
                freshProducts.get(wcId),
              ])
            }
            const twin = await env.app.services.product.getById(after.wcToNymbalProduct[SLUG_TWIN]!)
            expect(twin.slug).toBe(twinSlug)
            expect(untouched.map((id) => productRows(env, id))).toEqual(rowsBefore)
            await env.app.relay.drain()
            expect(updatedSince(env, seq).sort()).toEqual(
              changed.map((wcId) => before.wcToNymbalProduct[wcId]!).sort(),
            )
          } finally {
            await env.close()
          }
        },
      ),
      { numRuns: 15 },
    )
  }, 600_000)
})

// ── AC-3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-3: an imported order changed in WooCommerce', () => {
  it('AC-3: an imported order the delta lists is not written again (its row, history and number as they were, no error) and changedNotUpdated.orders counts it as 1', async () => {
    const env = await openStoreApp()
    try {
      const a = fixtureWithReviews()
      const importReport = (await runOver(env, { store: a })).report!
      const ordersBefore = env.rows('SELECT * FROM orders ORDER BY id')
      const historyBefore = env.rows('SELECT * FROM order_history ORDER BY id')
      const b: WooStore = {
        ...a,
        orders: a.orders.map((o) => ({
          ...o,
          status: 'cancelled',
          customer_note: 'changed after the import',
          date_modified_gmt: CHANGED_AT,
        })),
      }

      const report = (await runOver(env, { store: b, since: sinceForAll(SINCE) })).report!

      expect(report.changedNotUpdated?.orders).toBe(1)
      expect(env.rows('SELECT * FROM orders ORDER BY id')).toEqual(ordersBefore)
      expect(env.rows('SELECT * FROM order_history ORDER BY id')).toEqual(historyBefore)
      expect(report.errors).toEqual(importReport.errors)
    } finally {
      await env.close()
    }
  }, 120_000)
})

// ── AC-5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-5: a rollback after a delta', () => {
  it('AC-5: for generated sources over a store holding its own colliding records, an import, a delta that creates records of every entity and updates products, then a rollback leave every covered table as before the import', async () => {
    await fc.assert(
      fc.asyncProperty(deltas(imported({ products: 4 })), async ([a, extra, plans]) => {
        // The new product's slug is its own: whether one the store holds is suffixed is AC-2's, not the rollback's.
        const { source: b } = changedSource(a, extra, plans, 'delta-new-product')
        const env = await openStoreApp()
        try {
          await seedStore(env)
          const before = env.covered()
          await runOver(env, { store: a })
          const afterImport = entityRows(env)

          await runOver(env, { store: b, since: sinceForAll(SINCE) })
          const afterDelta = entityRows(env)
          await rollbackImport(
            { statePath: env.statePath, confirm: async () => true },
            { services: env.app.services, repos: env.app.repos },
          )

          expect(ALL_ENTITIES.filter((e) => afterDelta[e] <= afterImport[e])).toEqual([])
          expectTablesAsBefore(before, env.covered())
          expect(await env.readModelDifferences()).toEqual([])
        } finally {
          await env.close()
        }
      }),
      { numRuns: 15 },
    )
  }, 600_000)
})

// ── AC-6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-6: a delta stopped and resumed', () => {
  it('AC-6: stopped after its first products page, a run with no since finishes the pass with the same filter, creates nothing twice, carries the updated count across the stop, and leaves no delta and one new runs entry with that since', async () => {
    const env = await openStoreApp()
    try {
      const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)
      // Products 31-60 are not in the source until the delta, so its first page holds new products and changed ones.
      const a: WooStore = {
        categories: [category(1)],
        products: [...ids(1, 30), ...ids(61, 120)].map((id) => simpleProduct(id)),
        variations: {},
        customers: [customer(1)],
        orders: [order(50_001, 1, 1)],
        reviews: [review(1, 1)],
      }
      await runOver(env, { store: a })
      const runsBefore = (await stateOf(env)).runs?.length ?? 0
      // Listed: 1-30 renamed, 31-60 new, 61-150 renamed (page 1 ends at 100), with one new record of each other kind.
      const b: WooStore = {
        categories: [...a.categories, category(2)],
        products: [
          ...a.products.map((p) =>
            (p['id'] as number) <= 150
              ? { ...p, name: `${String(p['name'])} renamed`, date_modified_gmt: CHANGED_AT }
              : p,
          ),
          ...ids(31, 30).map((id) => simpleProduct(id, { date_modified_gmt: CHANGED_AT })),
        ],
        variations: {},
        customers: [...a.customers, customer(2)],
        orders: [...a.orders, order(50_002, 31, 2, { date_modified_gmt: CHANGED_AT })],
        reviews: [...a.reviews, review(2, 31, { date_created_gmt: CHANGED_AT })],
      }

      await runOver(env, {
        store: b,
        since: sinceForAll(SINCE),
        hold: (u) => u.pathname.endsWith('/products') && u.searchParams.get('page') === '2',
      })
      const resumed = await runOver(env, { store: b })

      expect(entityRows(env)).toEqual({
        categories: b.categories.length,
        products: b.products.length,
        customers: b.customers.length,
        orders: b.orders.length,
        reviews: b.reviews.length,
      })
      const filtered = resumed.requests.filter((r) =>
        ['/products', '/orders', '/products/reviews'].includes(resourceOf(r) ?? ''),
      )
      expect([...new Set(filtered.map(resourceOf))].sort()).toEqual(
        ['/orders', '/products', '/products/reviews'].sort(),
      )
      expect(
        filtered.map((r) => {
          const p = dateParams(r)
          return [resourceOf(r), p.modified_after ?? p.after?.replace(/Z$/, '') ?? null]
        }),
      ).toEqual(
        filtered.map((r) => [
          resourceOf(r),
          resourceOf(r) === '/products/reviews' ? REVIEWS_AFTER : SINCE,
        ]),
      )
      expect(resumed.report!.updated?.products).toBe(120)
      const state = await stateOf(env)
      expect(state.delta).toBeUndefined()
      expect(state.runs?.length).toBe(runsBefore + 1)
      expect(state.runs?.at(-1)?.since?.products).toBe(SINCE)
      expect(state.runs?.at(-1)?.since?.orders).toBe(SINCE)
    } finally {
      await env.close()
    }
  }, 300_000)
})

