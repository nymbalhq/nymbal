import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currencyRefusal,
  planWooCommerceImport,
  runWooCommerceImport,
  writePlan,
  WRITE_MS,
  type ExistingStoreLookup,
  type ImportEntity,
  type ImportPlan,
  type PlanEntity,
} from '@nymbalhq/importers'
import type { MediaStorage } from '@nymbalhq/types'
import { buildImportEnv, WC_URL } from './support/import-env.js'
import {
  arbStore,
  clashFree,
  currencySettings,
  fixtureStore,
  isApiRequest,
  statusAnswer,
  totalAnswer,
  wooStoreFetch,
  type Rec,
  type WooStore,
} from './support/woo-store.js'

// The import plan (`nymbal import --dry-run`) against the import itself: the same stores, served by one fetch mock,
// planned and then imported for real on a fresh migrated SQLite at concurrency 1. Runs against the built dist
// (`pnpm build`).

const ALL: ImportEntity[] = ['categories', 'products', 'customers', 'orders', 'reviews']
const PLAN_ENTITIES: PlanEntity[] = [...ALL, 'variations']
/** Every plan request costs this much on the test's clock, and nothing else moves it. */
const REQUEST_MS = 37

type PlanOpts = Parameters<typeof planWooCommerceImport>[0]

function planOptions(over: Partial<PlanOpts> = {}): PlanOpts {
  return {
    credentials: { url: WC_URL, consumerKey: 'ck_test', consumerSecret: 'cs_test' },
    entities: ALL,
    gdpr: true,
    currency: 'GBP',
    concurrency: 1,
    ...over,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The plan over `store`, on a clock that advances REQUEST_MS for each request the plan makes and at no other time. */
async function planOf(
  store: WooStore,
  opts: PlanOpts,
  existing: ExistingStoreLookup | null = null,
): Promise<ImportPlan> {
  let clock = 0
  const mock = wooStoreFetch(store, {
    onRequest: () => {
      clock += REQUEST_MS
    },
  })
  vi.stubGlobal('fetch', mock.fetch)
  try {
    return await planWooCommerceImport(opts, { existing, now: () => clock })
  } finally {
    vi.unstubAllGlobals()
  }
}

const media: MediaStorage = {
  capabilities: () => ['put'],
  async put(key) {
    return { url: `/imported-media/${key}` }
  },
}

/** A real import of `store` with the plan's options, on a fresh migrated SQLite. */
async function importOf(store: WooStore, opts: PlanOpts) {
  const env = await buildImportEnv()
  const dir = await mkdtemp(join(tmpdir(), 'nymbal-plan-import-'))
  const mock = wooStoreFetch(store)
  vi.stubGlobal('fetch', mock.fetch)
  try {
    const report = await runWooCommerceImport(
      {
        ...opts,
        ai: false,
        fresh: true,
        projectRoot: dir,
        statePath: join(dir, '.nymbal-migration.json'),
      },
      { services: env.services, repos: env.repos, adapters: env.adapters, media },
    )
    return { report, requests: mock.requests }
  } finally {
    vi.unstubAllGlobals()
    await env.close()
    await rm(dir, { recursive: true, force: true })
  }
}

function sourceCount(store: WooStore, e: ImportEntity): number {
  return store[e].length
}

/** Each value once, in order: a product refused for its slug and a SKU is one refusal. */
const sorted = (values: Array<string | undefined>): Array<string | undefined> =>
  [...new Set(values)].sort()

/** Small stores, and stores whose products cross the 100-per-page boundary. */
const sizedStores = arbStore({
  products: fc.oneof(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 101, max: 250 })),
})

describe('AC-1: the plan counts what the import imports', () => {
  it("AC-1: for the hand-written fixture store, every entity's planned import count is the import's, and source = import + refused + skipped", async () => {
    const store = fixtureStore()
    const opts = planOptions()
    const plan = await planOf(store, opts)
    const { report } = await importOf(store, opts)

    expect(Object.fromEntries(ALL.map((e) => [e, plan.counts[e].import]))).toEqual(report.imported)
    for (const e of ALL) {
      const c = plan.counts[e]
      expect(c.import + c.refused + c.skipped, e).toBe(c.source)
      expect(c.source, e).toBe(sourceCount(store, e))
    }
  }, 60_000)

  // Kills: the import creating products in the order their downloads finish, so of two clashing products the later
  // keeps the slug or SKU the plan gave the earlier.
  it("AC-1: for generated stores with clashing slugs and SKUs, at any concurrency, every entity's planned import count is the import's and the import refuses the very products the plan does", async () => {
    await fc.assert(
      fc.asyncProperty(
        sizedStores,
        fc.boolean(),
        fc.integer({ min: 1, max: 8 }),
        async (store, gdpr, concurrency) => {
          const opts = planOptions({ gdpr, concurrency })
          const plan = await planOf(store, opts)
          const { report } = await importOf(store, opts)

          // The first record of a source clash keeps the value; every later one is refused.
          const planRefused = plan.collisions
            .filter((c) => c.with === 'source' && (c.kind === 'product-slug' || c.kind === 'sku'))
            .flatMap((c) => c.sourceIds.slice(1))
          const importRefused = report.errors.filter((e) => e.phase === 'products').map((e) => e.id)
          expect(sorted(importRefused), `concurrency ${concurrency}`).toEqual(sorted(planRefused))
          expect(Object.fromEntries(ALL.map((e) => [e, plan.counts[e].import]))).toEqual(
            report.imported,
          )
          for (const e of ALL) {
            const c = plan.counts[e]
            expect(c.import + c.refused + c.skipped, e).toBe(c.source)
            expect(c.source, e).toBe(sourceCount(store, e))
          }
        },
      ),
      { numRuns: 15 },
    )
  }, 600_000)

  it('AC-1: an entity that is not selected counts 0 source, 0 import, 0 refused and 0 skipped', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStore({ products: fc.integer({ min: 0, max: 6 }) }),
        fc.subarray(ALL),
        async (store, entities) => {
          const plan = await planOf(store, planOptions({ entities }))
          for (const e of ALL) {
            const c = plan.counts[e]
            const expected = entities.includes(e) ? sourceCount(store, e) : 0
            expect([e, c.source], e).toEqual([e, expected])
            expect(c.import + c.refused + c.skipped, e).toBe(c.source)
          }
        },
      ),
      { numRuns: 20 },
    )
  }, 120_000)
})

describe('AC-3: unmapped fields are what the import never reads', () => {
  const ALWAYS_READ: Record<PlanEntity, string[]> = {
    categories: ['id', 'name', 'slug', 'parent'],
    products: [
      'id',
      'name',
      'slug',
      'sku',
      'type',
      'status',
      'description',
      'categories',
      'images',
      'variations',
    ],
    variations: [
      'sku',
      'regular_price',
      'sale_price',
      'stock_quantity',
      'status',
      'attributes',
      'weight',
    ],
    customers: ['id'],
    orders: [
      'id',
      'number',
      'status',
      'customer_id',
      'line_items',
      'total',
      'total_tax',
      'discount_total',
    ],
    reviews: ['product_id'],
  }
  const freshKey = word().map((w) => `zz_${w}`)
  const presentScalar = fc.oneof(word(), fc.integer(), fc.boolean())

  function word() {
    return fc.string({
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
      minLength: 1,
      maxLength: 8,
    })
  }

  function withKey(records: Rec[], key: string, value: unknown): Rec[] {
    return records.map((r) => ({ ...r, [key]: value }))
  }

  it('AC-3: a key added to every source record of an entity is listed for that entity with records equal to its source count, and no field the import reads is listed', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStore({ products: fc.integer({ min: 1, max: 15 }) }),
        fc.record({
          categories: freshKey,
          products: freshKey,
          variations: freshKey,
          customers: freshKey,
          orders: freshKey,
          reviews: freshKey,
        }),
        presentScalar,
        fc.boolean(),
        async (base, keys, value, gdpr) => {
          const store: WooStore = {
            ...base,
            categories: withKey(base.categories, keys.categories, value),
            products: withKey(base.products, keys.products, value),
            customers: withKey(base.customers, keys.customers, value),
            orders: withKey(base.orders, keys.orders, value),
            reviews: withKey(base.reviews, keys.reviews, value),
            variations: Object.fromEntries(
              Object.entries(base.variations).map(([id, vs]) => [
                id,
                withKey(vs, keys.variations, value),
              ]),
            ),
          }
          const sources: Record<PlanEntity, number> = {
            categories: store.categories.length,
            products: store.products.length,
            customers: store.customers.length,
            orders: store.orders.length,
            reviews: store.reviews.length,
            variations: Object.values(store.variations).reduce((n, vs) => n + vs.length, 0),
          }
          const plan = await planOf(store, planOptions({ gdpr }))

          const listed = Object.fromEntries(
            PLAN_ENTITIES.filter((e) => sources[e] > 0).map((e) => [
              e,
              plan.unmapped[e].find((f) => f.field === keys[e])?.records ?? 'not listed',
            ]),
          )
          const expected = Object.fromEntries(
            PLAN_ENTITIES.filter((e) => sources[e] > 0).map((e) => [e, sources[e]]),
          )
          expect(listed).toEqual(expected)

          const readButListed = PLAN_ENTITIES.flatMap((e) =>
            plan.unmapped[e]
              .map((f) => `${e}.${f.field}`)
              .filter((f) => ALWAYS_READ[e].some((r) => f === `${e}.${r}`)),
          )
          expect(readButListed).toEqual([])
        },
      ),
      { numRuns: 25 },
    )
  }, 120_000)

  // The fixtures' `meta_data` arrays are all empty, which the presence rule does not count; one product carries a
  // meta entry here so that the field is present, as it is in any real store.
  const fixtureWithMeta = () => {
    const store = fixtureStore()
    store.products = store.products.map((p, i) =>
      i === 0 ? { ...p, meta_data: [{ id: 1, key: '_wc_note', value: 'gift wrap' }] } : p,
    )
    return store
  }

  it('AC-3: for the fixture store, unmapped products include backorders and not meta_data, attributes, regular_price or slug', async () => {
    const plan = await planOf(fixtureWithMeta(), planOptions())
    const fields = plan.unmapped.products.map((f) => f.field)

    expect(
      ['backorders', 'meta_data', 'attributes', 'regular_price', 'slug'].map((f) => [
        f,
        fields.includes(f),
      ]),
    ).toEqual([
      ['backorders', true],
      ['meta_data', false],
      ['attributes', false],
      ['regular_price', false],
      ['slug', false],
    ])
  })

  it('AC-3: under --gdpr the customer email and billing.address_1 are unmapped, and without it neither is', async () => {
    const store = fixtureWithMeta()
    const listedUnder = async (gdpr: boolean) => {
      const plan = await planOf(store, planOptions({ gdpr }))
      const fields = plan.unmapped.customers.map((f) => f.field)
      return ['email', 'billing.address_1'].filter((f) => fields.includes(f))
    }

    expect({ gdpr: await listedUnder(true), plain: await listedUnder(false) }).toEqual({
      gdpr: ['email', 'billing.address_1'],
      plain: [],
    })
  })
})

// ── Hand-built records ──────────────────────────────────────────────────────────────────────────────────────────

function category(id: number, name: string, slug: string): Rec {
  return { id, name, slug, parent: 0, description: '', count: 0 }
}

function product(id: number, over: Rec): Rec {
  return {
    id,
    name: `product ${id}`,
    slug: `product-${id}`,
    type: 'simple',
    status: 'publish',
    description: '',
    short_description: '',
    sku: `SKU-${id}`,
    price: '10.00',
    regular_price: '10.00',
    sale_price: '',
    on_sale: false,
    date_on_sale_from: null,
    date_on_sale_to: null,
    manage_stock: false,
    stock_quantity: null,
    stock_status: 'instock',
    backorders: 'no',
    low_stock_amount: null,
    tags: [],
    tax_status: 'taxable',
    tax_class: '',
    shipping_class: '',
    grouped_products: [],
    external_url: '',
    categories: [],
    images: [],
    attributes: [],
    variations: [],
    meta_data: [],
    downloadable: false,
    virtual: false,
    weight: '',
    dimensions: { length: '', width: '', height: '' },
    ...over,
  }
}

function variation(id: number, sku: string): Rec {
  return {
    id,
    sku,
    price: '12.00',
    regular_price: '12.00',
    sale_price: '',
    on_sale: false,
    date_on_sale_from: null,
    date_on_sale_to: null,
    manage_stock: true,
    stock_quantity: 3,
    stock_status: 'instock',
    backorders: 'no',
    low_stock_amount: null,
    tax_status: 'taxable',
    tax_class: '',
    shipping_class: '',
    status: 'publish',
    attributes: [{ id: 1, name: 'Size', option: `s${id}` }],
    weight: '',
    dimensions: { length: '', width: '', height: '' },
  }
}

const PHASE: Record<string, ImportEntity> = {
  'product-slug': 'products',
  sku: 'products',
  'category-slug': 'categories',
  'customer-email': 'customers',
  'order-number': 'orders',
}

describe('AC-4: clashes within the source', () => {
  const store: WooStore = {
    categories: [category(1, 'Home Goods', 'home_goods'), category(2, 'Home goods', 'home-goods')],
    products: [
      product(10, { slug: 'summer_tee', sku: 'ST-1' }),
      product(11, { slug: 'summer-tee', sku: 'ST-2' }),
      product(12, { slug: 'cap', type: 'variable', variations: [301] }),
      product(13, { slug: 'hat', type: 'variable', variations: [401] }),
    ],
    variations: { 12: [variation(301, 'SHARED')], 13: [variation(401, 'SHARED')] },
    customers: [],
    orders: [],
    reviews: [],
  }
  const opts = planOptions({ entities: ['categories', 'products'] })

  it('AC-4: raw slugs that slugify alike, a SKU two variants share, and category slugs that slugify alike are one refused source collision each, naming both ids', async () => {
    const plan = await planOf(store, opts)
    const summary = plan.collisions
      .filter((c) => c.with === 'source')
      .map((c) => ({ kind: c.kind, ids: [...c.sourceIds].sort(), outcome: c.outcome }))
      .sort((a, b) => a.kind.localeCompare(b.kind))

    expect(summary).toEqual([
      { kind: 'category-slug', ids: ['1', '2'], outcome: 'refused' },
      { kind: 'product-slug', ids: ['10', '11'], outcome: 'refused' },
      { kind: 'sku', ids: ['12', '13'], outcome: 'refused' },
    ])
  })

  it("AC-4: a real import of the same source reports exactly sourceIds.length - 1 of each collision's ids as errors in that phase", async () => {
    const plan = await planOf(store, opts)
    const { report } = await importOf(store, opts)

    const relation = plan.collisions.map((c) => {
      const failed = report.errors.filter(
        (e) => e.phase === PHASE[c.kind] && e.id !== undefined && c.sourceIds.includes(e.id),
      )
      return { kind: c.kind, failed: failed.length, expected: c.sourceIds.length - 1 }
    })
    expect(relation.map((r) => [r.kind, r.failed])).toEqual(
      relation.map((r) => [r.kind, r.expected]),
    )
    expect(plan.counts.products.refused).toBe(
      report.errors.filter((e) => e.phase === 'products').length,
    )
    expect(plan.counts.categories.refused).toBe(
      report.errors.filter((e) => e.phase === 'categories').length,
    )
  })
})

/** The lookup over what a store holds; the email set holds lowercased addresses, as the store does. */
function lookupOver(held: {
  productSlugs?: string[]
  skus?: string[]
  categorySlugs?: string[]
  emails?: string[]
  orderNumbers?: string[]
}): ExistingStoreLookup {
  const has = (xs: string[] | undefined) => async (v: string) => (xs ?? []).includes(v)
  return {
    productSlugExists: has(held.productSlugs),
    skuExists: has(held.skus),
    categorySlugExists: has(held.categorySlugs),
    customerEmailExists: has(held.emails),
    orderNumberExists: has(held.orderNumbers),
  }
}

const gdprEmail = (wcId: number) =>
  `customer-${createHash('sha256').update(String(wcId)).digest('hex').slice(0, 12)}@imported.nymbal.local`

describe('AC-5: clashes with what the store already holds', () => {
  const books = category(12, 'Books', 'books')
  const storeWithBooks = () => fixtureStore({ categories: [...fixtureStore().categories, books] })

  function storeCollisions(plan: ImportPlan) {
    return plan.collisions
      .filter((c) => c.with === 'store')
      .map((c) => ({
        kind: c.kind,
        value: c.value,
        ids: [...c.sourceIds].sort(),
        outcome: c.outcome,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind))
  }

  /** Per entity, the source records some refused collision names. */
  function refusedIds(plan: ImportPlan, e: ImportEntity): number {
    return new Set(
      plan.collisions
        .filter((c) => c.outcome === 'refused' && PHASE[c.kind] === e)
        .flatMap((c) => c.sourceIds),
    ).size
  }

  it('AC-5: a held product slug, SKU, category slug, mapped customer email and order number are each a store collision; the customer links and the rest are refused', async () => {
    const plan = await planOf(
      storeWithBooks(),
      planOptions({ gdpr: true }),
      lookupOver({
        productSlugs: ['classic-white-tee'],
        skus: ['GLT-M'],
        categorySlugs: ['books'],
        emails: [gdprEmail(1)],
        orderNumbers: ['WC-1000'],
      }),
    )

    expect(storeCollisions(plan)).toEqual([
      { kind: 'category-slug', value: 'books', ids: ['12'], outcome: 'refused' },
      { kind: 'customer-email', value: '', ids: ['1'], outcome: 'links-existing' },
      { kind: 'order-number', value: 'WC-1000', ids: ['1000'], outcome: 'refused' },
      { kind: 'product-slug', value: 'classic-white-tee', ids: ['100'], outcome: 'refused' },
      { kind: 'sku', value: 'GLT-M', ids: ['101'], outcome: 'refused' },
    ])
    expect(plan.existingStore).toBe('checked')
  })

  it('AC-5: counts move every refused record out of import, and a linked customer stays in it', async () => {
    const store = storeWithBooks()
    const opts = planOptions({ gdpr: true })
    const clean = await planOf(store, opts, lookupOver({}))
    const held = await planOf(
      store,
      opts,
      lookupOver({
        productSlugs: ['classic-white-tee'],
        skus: ['GLT-M'],
        categorySlugs: ['books'],
        emails: [gdprEmail(1)],
        orderNumbers: ['WC-1000'],
      }),
    )

    for (const e of ALL) {
      expect([e, held.counts[e].refused], e).toEqual([e, refusedIds(held, e)])
      expect([e, held.counts[e].import], e).toEqual([
        e,
        clean.counts[e].import - refusedIds(held, e),
      ])
    }
    expect(held.counts.customers.import).toBe(clean.counts.customers.import)
  })

  it('AC-5: without --gdpr the store lookup gets the source email lowercased, and the clash names the customer id only', async () => {
    const store = fixtureStore()
    store.customers = store.customers.map((c) => ({ ...c, email: 'Alice@Example.COM' }))
    const plan = await planOf(
      store,
      planOptions({ gdpr: false }),
      lookupOver({ emails: ['alice@example.com'] }),
    )

    expect(storeCollisions(plan).filter((c) => c.kind === 'customer-email')).toEqual([
      { kind: 'customer-email', value: '', ids: ['1'], outcome: 'links-existing' },
    ])
  })

  it('AC-5: with no store to check, the plan says why in existingStore and still counts the source', async () => {
    const store = fixtureStore()
    const plan = await planOf(store, planOptions(), null)

    expect(typeof plan.existingStore === 'object' && plan.existingStore.notChecked.length > 0).toBe(
      true,
    )
    expect(plan.counts.products.source).toBe(store.products.length)
  })
})

describe('AC-6: the estimate', () => {
  function formula(plan: ImportPlan, concurrency: number): number {
    const { meanRequestMs: m, requests, writes } = plan.estimate
    return Math.ceil(
      (m * requests.api + (m * requests.images) / concurrency + WRITE_MS * writes) / 1000,
    )
  }

  it('AC-6: over generated stores, the planned API and image requests are the ones the import makes, and seconds follows the stated formula', async () => {
    await fc.assert(
      fc.asyncProperty(sizedStores, fc.integer({ min: 2, max: 8 }), async (store, concurrency) => {
        const opts = planOptions()
        const plan = await planOf(store, opts)
        const { requests } = await importOf(store, opts)

        expect({
          api: plan.estimate.requests.api,
          images: plan.estimate.requests.images,
        }).toEqual({
          api: requests.filter(isApiRequest).length,
          images: requests.filter((r) => !isApiRequest(r)).length,
        })
        expect(plan.estimate.meanRequestMs).toBe(REQUEST_MS)
        expect(plan.estimate.writes).toBe(ALL.reduce((n, e) => n + plan.counts[e].import, 0))
        expect(plan.estimate.seconds).toBe(formula(plan, 1))

        const wide = await planOf(store, planOptions({ concurrency }))
        expect(wide.estimate.seconds).toBe(formula(wide, concurrency))
      }),
      { numRuns: 15 },
    )
  }, 600_000)
})

describe("AC-7: what won't migrate", () => {
  const withProbes = (over: Partial<WooStore> = {}) =>
    fixtureStore({
      reviews: [
        {
          id: 1,
          product_id: 100,
          reviewer: 'r',
          reviewer_email: 'r@example.com',
          review: 'ok',
          rating: 4,
          verified: false,
          date_created: '2024-03-01T09:00:00',
        },
        {
          id: 2,
          product_id: 101,
          reviewer: 's',
          reviewer_email: 's@example.com',
          review: 'fine',
          rating: 5,
          verified: true,
          date_created: '2024-03-02T09:00:00',
        },
      ],
      coupons: totalAnswer(7),
      taxes: totalAnswer(3),
      shippingZones: {
        status: 200,
        body: [
          { id: 0, name: 'Rest of world' },
          { id: 1, name: 'UK' },
        ],
      },
      ...over,
    })
  const counts = (plan: ImportPlan) => plan.wontMigrate.map((w) => [w.item, w.count])

  it('AC-7: coupons, tax rates and shipping zones carry the source counts, then passwords, pages and posts, then each unselected entity with its source total', async () => {
    const store = withProbes()
    const plan = await planOf(store, planOptions({ entities: ['categories', 'products'] }))

    expect(counts(plan)).toEqual([
      ['coupons', 7],
      ['tax rates', 3],
      ['shipping zones', 2],
      ['customer passwords', plan.counts.customers.import],
      ['WordPress pages and posts', null],
      ['customers', store.customers.length],
      ['orders', store.orders.length],
      ['reviews', store.reviews.length],
    ])
  })

  it('AC-7: customer passwords count the customers the import would create', async () => {
    const plan = await planOf(
      withProbes(),
      planOptions({ entities: ['categories', 'products', 'customers', 'orders'] }),
    )
    const passwords = plan.wontMigrate.find((w) => w.item === 'customer passwords')

    expect(passwords?.count).toBe(plan.counts.customers.import)
    expect(plan.counts.customers.import).toBe(fixtureStore().customers.length)
  })

  it('AC-16: customer passwords keeps its count, and its why names --password-hashes rather than telling the merchant every customer must reset', async () => {
    const plan = await planOf(
      withProbes(),
      planOptions({ entities: ['categories', 'products', 'customers', 'orders'] }),
    )
    const passwords = plan.wontMigrate.find((w) => w.item === 'customer passwords')

    expect(passwords?.count).toBe(plan.counts.customers.import)
    expect(passwords?.why).toMatch(/--password-hashes/)
    expect(passwords?.why).not.toMatch(/does not export password hashes|reset theirs|must reset/i)
  })

  it('AC-7: a probe answering 401, 404 or a body of the wrong shape counts null and the plan still completes', async () => {
    const opts = planOptions({ entities: ['categories', 'products'] })
    const answered = await planOf(withProbes(), opts)
    const refused = await planOf(
      withProbes({ coupons: statusAnswer(401), shippingZones: statusAnswer(404) }),
      opts,
    )
    const misshapen = await planOf(
      withProbes({
        // A total in the header over a body that is not a list: the shape decides, not the header.
        taxes: { status: 200, body: { not: 'a list' }, headers: { 'X-WP-Total': '3' } },
        shippingZones: { status: 200, body: { zones: 2 } },
      }),
      opts,
    )
    const rows = (plan: ImportPlan) => Object.fromEntries(counts(plan).slice(0, 3))

    expect(rows(refused)).toEqual({ ...rows(answered), coupons: null, 'shipping zones': null })
    expect(rows(misshapen)).toEqual({
      ...rows(answered),
      'tax rates': null,
      'shipping zones': null,
    })
    expect(refused.counts).toEqual(answered.counts)
  })
})

describe('AC-9: no personal data in the plan files', () => {
  const token = fc.string({
    unit: fc.constantFrom(...'bcdfghjkmnpqrstvwxz'.split('')),
    minLength: 12,
    maxLength: 12,
  })
  const digits = fc.string({
    unit: fc.constantFrom(...'0123456789'.split('')),
    minLength: 9,
    maxLength: 9,
  })
  const person = fc.record({
    email: fc.tuple(token, token).map(([a, b]) => `${a}@${b}.test`),
    first: token,
    last: token,
    line1: token,
    line2: token,
    postcode: token,
    phone: digits.map((d) => `07${d}`),
  })

  function addressOf(
    p: {
      first: string
      last: string
      line1: string
      line2: string
      postcode: string
      phone: string
    },
    email?: string,
  ): Rec {
    return {
      first_name: p.first,
      last_name: p.last,
      company: '',
      address_1: p.line1,
      address_2: p.line2,
      city: 'leeds',
      state: 'yorkshire',
      postcode: p.postcode,
      country: 'GB',
      phone: p.phone,
      ...(email !== undefined && { email }),
    }
  }

  it('AC-9: under --gdpr and without it, no customer or order email, name, phone, address line or postcode reaches nymbal-import-plan.json or .md', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(person, { minLength: 1, maxLength: 6 }),
        fc.array(fc.nat(), { maxLength: 3 }),
        fc.array(person, { maxLength: 4 }),
        async (people, twins, buyers) => {
          // Customers share an email now and then (a source clash), and the store holds the first customer's (a
          // store clash), under either email rule.
          const customers: Rec[] = people.map((p, i) => {
            const twin = twins[i] !== undefined && i > 0 ? people[twins[i]! % i]! : p
            return {
              id: i + 1,
              email: twin.email,
              first_name: p.first,
              last_name: p.last,
              username: `user${i + 1}`,
              billing: addressOf(p, twin.email),
              shipping: addressOf(p),
              meta_data: [],
              date_created: '2024-01-15T10:00:00',
            }
          })
          const orders: Rec[] = buyers.map((p, i) => ({
            ...fixtureStore().orders[0],
            id: 60_000 + i,
            number: String(9_000 + i),
            customer_id: i + 1,
            billing: addressOf(p, p.email),
            shipping: addressOf(p),
          }))
          const store = fixtureStore({ customers, orders })
          const pii = [...people, ...buyers].flatMap((p) => [
            p.email,
            p.first,
            p.last,
            p.line1,
            p.line2,
            p.postcode,
            p.phone,
          ])
          const firstEmail = (customers[0]!['email'] as string).toLowerCase()

          for (const gdpr of [true, false]) {
            const dir = await mkdtemp(join(tmpdir(), 'nymbal-plan-pii-'))
            try {
              const plan = await planOf(
                store,
                planOptions({ gdpr, entities: ['customers', 'orders'] }),
                lookupOver({ emails: [gdpr ? gdprEmail(1) : firstEmail] }),
              )
              const paths = await writePlan(plan, dir, 'pii-store')
              const text =
                (await readFile(paths.json, 'utf8')) + (await readFile(paths.markdown, 'utf8'))
              const lower = text.toLowerCase()

              expect(pii.filter((v) => lower.includes(v.toLowerCase()))).toEqual([])
              const emailClashes = plan.collisions.filter((c) => c.kind === 'customer-email')
              expect(emailClashes.map((c) => c.value)).toEqual(emailClashes.map(() => ''))
              expect(
                emailClashes
                  .flatMap((c) => c.sourceIds)
                  .filter((id) => !customers.some((r) => String(r['id']) === id)),
              ).toEqual([])
              expect(
                emailClashes.filter((c) => c.with === 'store').flatMap((c) => c.sourceIds),
              ).toContain('1')
            } finally {
              await rm(dir, { recursive: true, force: true })
            }
          }
        },
      ),
      { numRuns: 25 },
    )
  }, 120_000)

  // Shapes measured to make the customer or order mapper throw, and the email modes each throws under (true: --gdpr).
  // None makes V8 quote a value of the record in its message, so the property holds the plan's own error text to it.
  const CUSTOMER_SHAPES: Array<{ apply: (r: Rec, email: string) => Rec; throwsUnder: boolean[] }> =
    [
      { apply: (r) => r, throwsUnder: [] },
      { apply: (r) => ({ ...r, billing: null }), throwsUnder: [false] },
      { apply: (r, email) => ({ ...r, billing: email }), throwsUnder: [] },
    ]
  const ORDER_SHAPES: Array<{ apply: (r: Rec, email: string) => Rec; throwsUnder: boolean[] }> = [
    { apply: (r) => r, throwsUnder: [] },
    { apply: (r) => ({ ...r, billing: null }), throwsUnder: [true, false] },
    { apply: (r) => ({ ...r, shipping: null }), throwsUnder: [true, false] },
    { apply: (r) => ({ ...r, shipping_lines: null }), throwsUnder: [true, false] },
    {
      apply: (r, email) => ({
        ...r,
        billing: { ...(r['billing'] as Rec), email: { address: email } },
      }),
      throwsUnder: [false],
    },
  ]
  /** The ORDER_SHAPES that throw under either email mode. */
  const THROWS_EITHER_WAY = [1, 2, 3]

  it('AC-8: with customer and order records whose mapper throws, under --gdpr and without it, no email, name, phone, address line or postcode reaches nymbal-import-plan.json or .md, and each listed error is a line of the .md', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(person, fc.nat()), { minLength: 1, maxLength: 5 }),
        fc.tuple(person, fc.constantFrom(...THROWS_EITHER_WAY)),
        fc.array(fc.tuple(person, fc.nat()), { maxLength: 4 }),
        async (people, firstBuyer, moreBuyers) => {
          const buyers = [firstBuyer, ...moreBuyers]
          const customerShape = people.map(([, n]) => CUSTOMER_SHAPES[n % CUSTOMER_SHAPES.length]!)
          const orderShape = buyers.map(([, n]) => ORDER_SHAPES[n % ORDER_SHAPES.length]!)
          const customers: Rec[] = people.map(([p], i) =>
            customerShape[i]!.apply(
              {
                id: i + 1,
                email: p.email,
                first_name: p.first,
                last_name: p.last,
                username: `user${i + 1}`,
                billing: addressOf(p, p.email),
                shipping: addressOf(p),
                meta_data: [],
                date_created: '2024-01-15T10:00:00',
              },
              p.email,
            ),
          )
          const orders: Rec[] = buyers.map(([p], i) =>
            orderShape[i]!.apply(
              {
                ...fixtureStore().orders[0],
                id: 60_000 + i,
                number: String(9_000 + i),
                customer_id: i + 1,
                billing: addressOf(p, p.email),
                shipping: addressOf(p),
              },
              p.email,
            ),
          )
          const store = fixtureStore({ customers, orders })
          const pii = [...people, ...buyers].flatMap(([p]) => [
            p.email,
            p.first,
            p.last,
            p.line1,
            p.line2,
            p.postcode,
            p.phone,
          ])

          for (const gdpr of [true, false]) {
            const throwing = [
              ...customers
                .filter((_, i) => customerShape[i]!.throwsUnder.includes(gdpr))
                .map((r) => ['customers', String(r['id'])]),
              ...orders
                .filter((_, i) => orderShape[i]!.throwsUnder.includes(gdpr))
                .map((r) => ['orders', String(r['id'])]),
            ]
            const dir = await mkdtemp(join(tmpdir(), 'nymbal-plan-pii-errors-'))
            try {
              const plan = await planOf(
                store,
                planOptions({ gdpr, entities: ['customers', 'orders'] }),
              )
              const paths = await writePlan(plan, dir, 'pii-store')
              const markdown = await readFile(paths.markdown, 'utf8')
              const lower = ((await readFile(paths.json, 'utf8')) + markdown).toLowerCase()

              expect(plan.errors.map((e) => [e.entity, e.sourceId])).toEqual(throwing)
              expect(pii.filter((v) => lower.includes(v.toLowerCase()))).toEqual([])
              const lines = markdown.split('\n')
              expect(
                plan.errors
                  .map((e) => `- ${e.entity} ${e.sourceId}: ${e.error}`)
                  .filter((line) => !lines.includes(line)),
              ).toEqual([])
            } finally {
              await rm(dir, { recursive: true, force: true })
            }
          }
        },
      ),
      { numRuns: 25 },
    )
  }, 120_000)
})

// ── Records the mapper cannot read ──────────────────────────────────────────────────────────────────────────────

/** Each entity's record at its pick (modulo the count), and the product a broken review points at. */
interface BreakPicks {
  categories: number
  products: number
  customers: number
  orders: number
  reviews: number
  reviewProduct: number
}

const breakPicks: fc.Arbitrary<BreakPicks> = fc.record({
  categories: fc.nat(),
  products: fc.nat(),
  customers: fc.nat(),
  orders: fc.nat(),
  reviews: fc.nat(),
  reviewProduct: fc.nat(),
})

/** Stores with at least one record of every entity, and two products or more. */
const breakableStores = (maxProducts: number) =>
  arbStore({ products: fc.integer({ min: 2, max: maxProducts }) }).filter((s) =>
    ALL.every((e) => s[e].length > 0),
  )

/**
 * `store` with one record of each entity given a field of the wrong type its mapper throws on without --gdpr: a
 * category slug that is a number, a product's `meta_data: null`, a customer's `billing: null`, an order's
 * `shipping_lines: null` and a review's `review: null`. The broken review points at a product other than the broken
 * one when `reviewOnOther`, else at any product. `broken` holds each entity's broken id, in the order the plan reads.
 */
function breakOnePerEntity(
  store: WooStore,
  picks: BreakPicks,
  reviewOnOther: boolean,
): { store: WooStore; broken: Array<[ImportEntity, string]> } {
  const at = (e: ImportEntity) => store[e][picks[e] % store[e].length]!['id'] as number
  const ids = Object.fromEntries(ALL.map((e) => [e, at(e)])) as Record<ImportEntity, number>
  const candidates = store.products
    .map((p) => p['id'] as number)
    .filter((id) => !reviewOnOther || id !== ids.products)
  const reviewProduct = candidates[picks.reviewProduct % candidates.length]!
  const swap = (e: ImportEntity, change: (r: Rec) => Rec) =>
    store[e].map((r) => (r['id'] === ids[e] ? change(r) : r))
  return {
    store: {
      ...store,
      categories: swap('categories', (r) => ({ ...r, slug: 42 })),
      products: swap('products', (r) => ({ ...r, meta_data: null })),
      customers: swap('customers', (r) => ({ ...r, billing: null })),
      orders: swap('orders', (r) => ({ ...r, shipping_lines: null })),
      reviews: swap('reviews', (r) => ({ ...r, review: null, product_id: reviewProduct })),
    },
    broken: ALL.map((e) => [e, String(ids[e])]),
  }
}

/** `store` without the records `broken` names. */
function without(store: WooStore, broken: Array<[ImportEntity, string]>): WooStore {
  const out: WooStore = { ...store }
  for (const [e, id] of broken) out[e] = store[e].filter((r) => String(r['id']) !== id)
  return out
}

describe('records the mapper cannot read', () => {
  it('AC-1: one record of each entity whose mapper throws is refused and listed once in errors with its entity and id, in source order; every other record plans as it would without them; source = import + refused + skipped', async () => {
    await fc.assert(
      fc.asyncProperty(breakableStores(10), breakPicks, async (generated, picks) => {
        // Clash-free, so every record but the broken ones imports and the broken review's product is planned.
        const { store, broken } = breakOnePerEntity(clashFree(generated), picks, true)
        const opts = planOptions({ gdpr: false })
        const plan = await planOf(store, opts)
        const rest = await planOf(without(store, broken), opts)

        expect(plan.errors.map((e) => [e.entity, e.sourceId])).toEqual(broken)
        expect(
          plan.errors.filter((e) => typeof e.error !== 'string' || e.error.trim() === ''),
        ).toEqual([])
        for (const e of ALL) {
          const c = plan.counts[e]
          const r = rest.counts[e]
          expect([e, c]).toEqual([e, { ...r, source: r.source + 1, refused: r.refused + 1 }])
          expect(c.import + c.refused + c.skipped, e).toBe(c.source)
        }
        expect(plan.collisions).toEqual(rest.collisions)
      }),
      { numRuns: 25 },
    )
  }, 120_000)

  // Kills: a broken record that still claims its slug, SKU, email or order number in the plan, so a later record that
  // shares it is planned as refused while the import, which never created the broken one, brings it over.
  it("AC-2: a real import at concurrency 1 of a source with one broken record per entity reports an error in each phase for exactly the ids the plan lists under errors, besides those a source collision refuses, and imports each entity's planned import count", async () => {
    await fc.assert(
      fc.asyncProperty(breakableStores(8), breakPicks, async (generated, picks) => {
        const { store } = breakOnePerEntity(generated, picks, false)
        const opts = planOptions({ gdpr: false, concurrency: 1 })
        const plan = await planOf(store, opts)
        const { report } = await importOf(store, opts)

        const refusedBySource = (e: ImportEntity) =>
          plan.collisions
            .filter((c) => c.with === 'source' && c.outcome === 'refused' && PHASE[c.kind] === e)
            .flatMap((c) => c.sourceIds.slice(1))
        for (const e of ALL) {
          const importErrors = report.errors.filter((x) => x.phase === e).map((x) => x.id)
          const planned = plan.errors.filter((x) => x.entity === e).map((x) => x.sourceId)
          expect([e, sorted(importErrors)]).toEqual([
            e,
            sorted([...planned, ...refusedBySource(e)]),
          ])
        }
        expect(Object.fromEntries(ALL.map((e) => [e, plan.counts[e].import]))).toEqual(
          report.imported,
        )
      }),
      { numRuns: 10 },
    )
  }, 600_000)
})

describe('a product whose own variations share a SKU', () => {
  const store: WooStore = {
    categories: [],
    products: [
      product(20, {
        slug: 'twin-tee',
        sku: 'TWIN-TEE',
        type: 'variable',
        variations: [2001, 2002],
      }),
      product(21, { slug: 'solo-tee', sku: 'SOLO' }),
    ],
    variations: { 20: [variation(2001, 'TWIN'), variation(2002, 'TWIN')] },
    customers: [],
    orders: [],
    reviews: [],
  }
  const opts = planOptions({ entities: ['categories', 'products'] })

  it('AC-3: a variable product whose two variations carry the same SKU is refused in the plan, with one sku source collision naming that product alone', async () => {
    const plan = await planOf(store, opts)

    expect(plan.collisions).toEqual([
      { kind: 'sku', with: 'source', value: 'TWIN', sourceIds: ['20'], outcome: 'refused' },
    ])
    expect(plan.counts.products).toEqual({
      source: store.products.length,
      import: store.products.length - 1,
      refused: 1,
      skipped: 0,
    })
  })

  it('AC-3: the real import reports one products error, for that product, creates neither it nor a variant with that SKU, and imports what the plan counts', async () => {
    const plan = await planOf(store, opts)
    const env = await buildImportEnv()
    const dir = await mkdtemp(join(tmpdir(), 'nymbal-plan-twin-sku-'))
    vi.stubGlobal('fetch', wooStoreFetch(store).fetch)
    try {
      const report = await runWooCommerceImport(
        {
          ...opts,
          ai: false,
          fresh: true,
          projectRoot: dir,
          statePath: join(dir, '.nymbal-migration.json'),
        },
        { services: env.services, repos: env.repos, adapters: env.adapters, media },
      )
      const slugs = (await env.services.product.list()).map((p) => p.slug)
      const twin = await env.commandStore.read((tx) => env.repos.variant.findBySku(tx, 'TWIN'))

      expect(report.errors.filter((e) => e.phase === 'products').map((e) => e.id)).toEqual(['20'])
      expect({ slugs, twin }).toEqual({ slugs: ['solo-tee'], twin: null })
      expect(report.imported.products).toBe(plan.counts.products.import)
    } finally {
      vi.unstubAllGlobals()
      await env.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a concurrency that is not a whole number of 1 or more', () => {
  const refusal = (c: number) => `concurrency must be a whole number of 1 or more, not ${c}`
  const notWhole = fc.oneof(
    fc.integer({ max: 0 }),
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((x) => !Number.isInteger(x)),
    fc.constant(Number.NaN),
  )
  const outcomeOf = (run: Promise<unknown>) =>
    run.then(
      () => ({ ran: true }),
      (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
    )

  it('AC-5: planWooCommerceImport rejects a concurrency that is 0 or less, not whole, or NaN, naming it, before any request', async () => {
    await fc.assert(
      fc.asyncProperty(notWhole, async (concurrency) => {
        const mock = wooStoreFetch(fixtureStore())
        vi.stubGlobal('fetch', mock.fetch)
        try {
          const outcome = await outcomeOf(
            planWooCommerceImport(planOptions({ concurrency }), { existing: null }),
          )
          expect({ outcome, requests: mock.requests.length }).toEqual({
            outcome: { refused: refusal(concurrency) },
            requests: 0,
          })
        } finally {
          vi.unstubAllGlobals()
        }
      }),
      { numRuns: 40, examples: [[0], [Number.NaN], [1.5], [-2]] },
    )
  })

  it('AC-5: runWooCommerceImport rejects a concurrency of 0, NaN, 1.5 or -2, naming it, before any request', async () => {
    const env = await buildImportEnv()
    try {
      for (const concurrency of [0, Number.NaN, 1.5, -2]) {
        const dir = await mkdtemp(join(tmpdir(), 'nymbal-import-concurrency-'))
        const mock = wooStoreFetch(fixtureStore())
        vi.stubGlobal('fetch', mock.fetch)
        try {
          const outcome = await outcomeOf(
            runWooCommerceImport(
              {
                ...planOptions({ concurrency }),
                ai: false,
                fresh: true,
                projectRoot: dir,
                statePath: join(dir, '.nymbal-migration.json'),
              },
              { services: env.services, repos: env.repos, adapters: env.adapters, media },
            ),
          )
          expect({ concurrency, outcome, requests: mock.requests.length }).toEqual({
            concurrency,
            outcome: { refused: refusal(concurrency) },
            requests: 0,
          })
        } finally {
          vi.unstubAllGlobals()
          await rm(dir, { recursive: true, force: true })
        }
      }
    } finally {
      await env.close()
    }
  })
})

describe('AC-2: the plan refuses the currency the import refuses', () => {
  const CODES = ['GBP', 'USD', 'EUR', 'JPY']
  /** `code` with each letter in either case: the platform reads a currency case-insensitively. */
  const anyCase = fc
    .constantFrom(...CODES)
    .chain((code) =>
      fc
        .array(fc.boolean(), { minLength: code.length, maxLength: code.length })
        .map((lower) => [...code].map((c, i) => (lower[i] ? c.toLowerCase() : c)).join('')),
    )
  /** A request for a record of any entity: categories, products, variations, customers, orders or reviews. */
  const RECORD = /^\/wp-json\/wc\/v3\/(products|customers|orders)(\/|$)/

  async function attempt(store: WooStore, opts: PlanOpts) {
    const mock = wooStoreFetch(store)
    vi.stubGlobal('fetch', mock.fetch)
    try {
      const outcome = await planWooCommerceImport(opts, { existing: null }).then(
        (plan) => ({ planned: plan.counts.products.source }),
        (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
      )
      return { outcome, records: mock.requests.filter((r) => RECORD.test(r.path)).length }
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it("AC-2: a source in another currency than the store's is refused with currencyRefusal(source, store) before any record is requested; a currency differing only in case, and settings that cannot be read, still plan", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(anyCase, { nil: null }),
        anyCase,
        async (source, storeCurrency) => {
          const store = fixtureStore({
            generalSettings: source === null ? statusAnswer(401) : currencySettings(source),
          })
          const refuses = source !== null && source.toUpperCase() !== storeCurrency.toUpperCase()

          const { outcome, records } = await attempt(
            store,
            planOptions({ currency: storeCurrency }),
          )

          expect({ outcome, records: refuses ? records : 0 }).toEqual({
            outcome: refuses
              ? { refused: currencyRefusal(source!, storeCurrency) }
              : { planned: store.products.length },
            records: 0,
          })
        },
      ),
      {
        numRuns: 40,
        examples: [
          ['USD', 'GBP'],
          ['gbp', 'GBP'],
          [null, 'GBP'],
        ],
      },
    )
  }, 120_000)
})
