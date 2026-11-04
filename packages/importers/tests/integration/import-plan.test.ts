import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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

  it("AC-1: for generated stores with clashing slugs and SKUs, every entity's planned import count is the import's at concurrency 1", async () => {
    await fc.assert(
      fc.asyncProperty(sizedStores, fc.boolean(), async (store, gdpr) => {
        const opts = planOptions({ gdpr })
        const plan = await planOf(store, opts)
        const { report } = await importOf(store, opts)

        expect(Object.fromEntries(ALL.map((e) => [e, plan.counts[e].import]))).toEqual(
          report.imported,
        )
        for (const e of ALL) {
          const c = plan.counts[e]
          expect(c.import + c.refused + c.skipped, e).toBe(c.source)
          expect(c.source, e).toBe(sourceCount(store, e))
        }
      }),
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
})
