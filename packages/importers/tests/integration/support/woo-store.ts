import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { WC_URL } from './import-env.js'

// A WooCommerce store as data, served by a fetch mock that paginates as WooCommerce does (`per_page`, `page`, ordered
// by id, `X-WP-Total` and `X-WP-TotalPages`), records every request, and answers the coupon, tax and shipping-zone
// endpoints only when the store says how. `arbStore` draws stores the import and the plan can both run on: names in
// `[a-z0-9 ]+`, order money that never refunds more than it took, product and order ids in disjoint ranges, and slugs
// and SKUs drawn from small pools so that clashes happen.

export type Rec = Record<string, unknown>

const API = '/wp-json/wc/v3'
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures', import.meta.url))

export interface ProbeAnswer {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export interface WooStore {
  categories: Rec[]
  products: Rec[]
  /** Each variable product's variations, by product id. */
  variations: Record<number, Rec[]>
  customers: Rec[]
  orders: Rec[]
  reviews: Rec[]
  coupons?: ProbeAnswer
  taxes?: ProbeAnswer
  shippingZones?: ProbeAnswer
}

/** A list endpoint's answer to a `per_page=1` request: the total is in the header. */
export function totalAnswer(total: number): ProbeAnswer {
  return {
    status: 200,
    body: total > 0 ? [{ id: 1 }] : [],
    headers: { 'X-WP-Total': String(total), 'X-WP-TotalPages': String(total) },
  }
}

export function statusAnswer(status: number): ProbeAnswer {
  return {
    status,
    body: { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' },
  }
}

export function fixtureRecords(name: string): Rec[] {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as Rec[]
}

/** The hand-written fixtures as a store: every variable product gets the fixture variations. */
export function fixtureStore(overrides: Partial<WooStore> = {}): WooStore {
  const products = fixtureRecords('products')
  const variations: Record<number, Rec[]> = {}
  for (const p of products) {
    if (p['type'] === 'variable') variations[p['id'] as number] = fixtureRecords('variations')
  }
  return {
    categories: fixtureRecords('categories'),
    products,
    variations,
    customers: fixtureRecords('customers'),
    orders: fixtureRecords('orders'),
    reviews: [],
    ...overrides,
  }
}

export interface RecordedRequest {
  method: string
  url: string
  path: string
}

export interface WooMock {
  fetch: typeof fetch
  requests: RecordedRequest[]
}

export const isApiRequest = (r: RecordedRequest): boolean => r.path.startsWith(`${API}/`)

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function byId(items: Rec[]): Rec[] {
  return [...items].sort((a, b) => (a['id'] as number) - (b['id'] as number))
}

/**
 * fetch over `store` at WC_URL. Images under `/img/` answer a few JPEG bytes; any other host answers 404. `onRequest`
 * runs as each request arrives, before it is answered (a test's virtual clock advances there).
 */
export function wooStoreFetch(store: WooStore, opts: { onRequest?: () => void } = {}): WooMock {
  const requests: RecordedRequest[] = []
  const origin = new URL(WC_URL).origin
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const u = new URL(href)
    requests.push({ method, url: href, path: u.pathname })
    opts.onRequest?.()
    if (u.origin !== origin) return new Response('not found', { status: 404 })
    if (u.pathname.startsWith('/img/')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (!u.pathname.startsWith(`${API}/`)) return json({ code: 'rest_no_route' }, 404)
    const path = u.pathname.slice(API.length)
    const page = Number(u.searchParams.get('page') ?? '1')
    const perPage = Number(u.searchParams.get('per_page') ?? '10')
    const list = (items: Rec[]) => {
      const sorted = byId(items)
      const pages = Math.max(1, Math.ceil(sorted.length / perPage))
      return json(sorted.slice((page - 1) * perPage, page * perPage), 200, {
        'X-WP-Total': String(sorted.length),
        'X-WP-TotalPages': String(pages),
      })
    }
    const probe = (answer: ProbeAnswer | undefined) =>
      answer === undefined
        ? json({ code: 'rest_no_route' }, 404)
        : json(answer.body, answer.status, answer.headers)
    if (path === '/system_status') return json({ environment: {} }, 200)
    if (path === '/products/categories') return list(store.categories)
    if (path === '/products') return list(store.products)
    if (path === '/products/reviews') return list(store.reviews)
    const variations = /^\/products\/(\d+)\/variations$/.exec(path)
    if (variations) return list(store.variations[Number(variations[1])] ?? [])
    if (path === '/customers') return list(store.customers)
    if (path === '/orders') return list(store.orders)
    if (path === '/coupons') return probe(store.coupons)
    if (path === '/taxes') return probe(store.taxes)
    if (path === '/shipping/zones') return probe(store.shippingZones)
    return json({ code: 'rest_no_route' }, 404)
  }
  return { fetch: fetchImpl as typeof fetch, requests }
}

// ── Generated stores ─────────────────────────────────────────────────────────────────────────────────────────────

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
const word = fc.string({ unit: fc.constantFrom(...ALNUM), minLength: 1, maxLength: 6 })
/** `[a-z0-9 ]+` with at least one letter or digit; a trailing space now and then (the import's raw slug keeps it). */
const nameArb = fc
  .tuple(fc.array(word, { minLength: 1, maxLength: 3 }), fc.boolean())
  .map(([words, trailing]) => words.join(' ') + (trailing ? ' ' : ''))

/** Raw slugs that slugify alike in pairs, and two the demo catalogue holds. */
export const SLUG_POOL = [
  'summer-tee',
  'summer_tee',
  'Summer-Tee',
  'red--cap',
  'red-cap',
  'books',
  'home',
]
/** SKUs shared across products, two of them equal to a pooled slug (a SKU falls back to the slug). */
export const SKU_POOL = ['SHARED-1', 'SHARED-2', 'summer-tee', 'red-cap']
export const EMAIL_POOL = ['dup@example.com', 'DUP@Example.com', 'twin@example.com']
export const ORDER_NUMBER_POOL = ['1', '2']
const STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
  'trash',
]

/** `null` is a value no other record has; a string is drawn from the pool; `''` is empty. */
const pooled = (pool: string[], weights: [number, number, number]) =>
  fc.oneof(
    { weight: weights[0], arbitrary: fc.constant<string | null>(null) },
    { weight: weights[1], arbitrary: fc.constantFrom<string | null>(...pool) },
    { weight: weights[2], arbitrary: fc.constant<string | null>('') },
  )

const money = (cents: number) => (cents / 100).toFixed(2)

function address(tag: string, email?: string): Rec {
  return {
    first_name: `fn${tag}`,
    last_name: `ln${tag}`,
    company: '',
    address_1: `${tag} high street`,
    address_2: '',
    city: 'leeds',
    state: 'yorkshire',
    postcode: `ls${tag}`,
    country: 'GB',
    phone: `0113${tag}`,
    ...(email !== undefined && { email }),
  }
}

const categoryDraft = fc.record({
  name: nameArb,
  slug: pooled(SLUG_POOL, [3, 2, 1]),
  parent: fc.option(fc.nat(), { nil: null }),
  description: fc.constantFrom('', 'all of it'),
})

const variationDraft = fc.record({
  sku: pooled(SKU_POOL, [2, 1, 2]),
  option: word,
  publish: fc.boolean(),
  priceCents: fc.integer({ min: 0, max: 50_000 }),
  stock: fc.option(fc.integer({ min: 0, max: 50 }), { nil: null }),
})

const productDraft = fc.record({
  name: nameArb,
  slug: pooled(SLUG_POOL, [3, 2, 1]),
  sku: pooled(SKU_POOL, [2, 1, 2]),
  variable: fc.boolean(),
  variations: fc.array(variationDraft, { maxLength: 3 }),
  publish: fc.boolean(),
  images: fc.array(fc.boolean(), { maxLength: 2 }),
  categoryPicks: fc.array(fc.nat(), { maxLength: 2 }),
  priceCents: fc.integer({ min: 0, max: 50_000 }),
  onSale: fc.boolean(),
})

const customerDraft = fc.record({
  email: pooled(EMAIL_POOL, [3, 2, 0]),
  first: word,
  last: word,
  hasAddress: fc.boolean(),
})

const orderDraft = fc.record({
  number: pooled(ORDER_NUMBER_POOL, [4, 1, 0]),
  customerPick: fc.option(fc.nat(), { nil: null }),
  lines: fc.array(
    fc.record({
      productPick: fc.option(fc.nat(), { nil: null }),
      qty: fc.integer({ min: 1, max: 5 }),
      priceCents: fc.integer({ min: 0, max: 20_000 }),
    }),
    { maxLength: 3 },
  ),
  status: fc.constantFrom(...STATUSES),
  totalCents: fc.integer({ min: 0, max: 500_000 }),
  taxCents: fc.integer({ min: 0, max: 20_000 }),
  shipCents: fc.integer({ min: 0, max: 2_000 }),
  discountCents: fc.integer({ min: 0, max: 5_000 }),
  note: fc.constantFrom('', 'leave at the door'),
})

const reviewDraft = fc.record({
  productPick: fc.option(fc.nat(), { nil: null }),
  rating: fc.integer({ min: 0, max: 6 }),
  text: nameArb,
})

export interface StoreSizes {
  products: fc.Arbitrary<number>
  categories?: number
  customers?: number
  orders?: number
  reviews?: number
}

/** Product ids start at 1, orders at ORDER_ID_BASE, variations at VARIATION_ID_BASE: the ranges never meet. */
export const ORDER_ID_BASE = 50_000
const VARIATION_ID_BASE = 100_000

export function arbStore(sizes: StoreSizes): fc.Arbitrary<WooStore> {
  return sizes.products.chain((productCount) =>
    fc
      .record({
        categories: fc.array(categoryDraft, { maxLength: sizes.categories ?? 8 }),
        products: fc.array(productDraft, { minLength: productCount, maxLength: productCount }),
        customers: fc.array(customerDraft, { maxLength: sizes.customers ?? 10 }),
        orders: fc.array(orderDraft, { maxLength: sizes.orders ?? 10 }),
        reviews: fc.array(reviewDraft, { maxLength: sizes.reviews ?? 8 }),
      })
      .map(buildStore),
  )
}

function buildStore(d: {
  categories: Array<typeof categoryDraft extends fc.Arbitrary<infer T> ? T : never>
  products: Array<typeof productDraft extends fc.Arbitrary<infer T> ? T : never>
  customers: Array<typeof customerDraft extends fc.Arbitrary<infer T> ? T : never>
  orders: Array<typeof orderDraft extends fc.Arbitrary<infer T> ? T : never>
  reviews: Array<typeof reviewDraft extends fc.Arbitrary<infer T> ? T : never>
}): WooStore {
  const categories: Rec[] = d.categories.map((c, i) => {
    const id = i + 1
    return {
      id,
      name: c.name,
      slug: c.slug ?? `cat-${id}`,
      // A parent is always an earlier category: the import creates them in id order.
      parent: c.parent !== null && i > 0 ? (c.parent % i) + 1 : 0,
      description: c.description,
      count: 0,
    }
  })

  let nextVariationId = VARIATION_ID_BASE
  const variations: Record<number, Rec[]> = {}
  const products: Rec[] = d.products.map((p, i) => {
    const id = i + 1
    const vars: Rec[] = []
    if (p.variable) {
      const taken = new Set<string>()
      for (const v of p.variations) {
        const vid = nextVariationId++
        let sku = v.sku ?? `V-${vid}`
        // Two variants of one product never share a SKU: that clash is inside one product, not between records.
        if (sku !== '' && taken.has(sku)) sku = ''
        if (sku !== '') taken.add(sku)
        vars.push({
          id: vid,
          sku,
          regular_price: money(v.priceCents),
          sale_price: '',
          stock_quantity: v.stock,
          status: v.publish ? 'publish' : 'private',
          attributes: [{ id: 1, name: 'Size', option: v.option }],
          weight: '0.5',
          dimensions: { length: '10', width: '10', height: '2' },
        })
      }
      variations[id] = vars
    }
    return {
      id,
      name: p.name,
      slug: p.slug ?? `p-${id}`,
      type: p.variable ? 'variable' : 'simple',
      status: p.publish ? 'publish' : 'draft',
      description: `about ${p.name}`,
      short_description: '',
      sku: p.sku ?? `SKU-${id}`,
      regular_price: money(p.priceCents),
      sale_price: p.onSale ? money(Math.floor(p.priceCents / 2)) : '',
      categories: p.categoryPicks.map((pick) => {
        const cat = categories.length > 0 ? categories[pick % (categories.length + 1)] : undefined
        return cat
          ? { id: cat['id'], name: cat['name'], slug: cat['slug'] }
          : { id: 9_999, name: 'gone', slug: 'gone' }
      }),
      images: p.images.map((hasSrc, n) => ({
        id: id * 10 + n,
        src: hasSrc ? `${WC_URL}/img/${id}-${n}.jpg` : '',
        name: `${id}-${n}`,
        alt: '',
      })),
      attributes: [],
      variations: vars.map((v) => v['id']),
      meta_data: [],
      downloadable: false,
      virtual: false,
      weight: '1',
      dimensions: { length: '20', width: '15', height: '5' },
    }
  })

  const customers: Rec[] = d.customers.map((c, i) => {
    const id = i + 1
    const email = c.email ?? `c${id}@example.com`
    return {
      id,
      email,
      first_name: c.first,
      last_name: c.last,
      username: `user${id}`,
      billing: c.hasAddress
        ? address(String(id), email)
        : { ...address(String(id), email), address_1: '' },
      shipping: address(String(id)),
      meta_data: [],
      date_created: '2024-01-15T10:00:00',
    }
  })

  const productIdAt = (pick: number | null) =>
    pick === null || products.length === 0
      ? 77_777
      : (products[pick % products.length]!['id'] as number)

  const orders: Rec[] = d.orders.map((o, i) => {
    const id = ORDER_ID_BASE + i
    const customer =
      o.customerPick === null
        ? 0
        : customers.length === 0
          ? 888
          : (customers[o.customerPick % customers.length]!['id'] as number)
    return {
      id,
      number: o.number ?? String(id),
      status: o.status,
      currency: 'GBP',
      date_created: '2024-02-01T12:00:00',
      customer_id: customer,
      billing: address(`o${id}`, `buyer${id}@example.com`),
      shipping: address(`o${id}`),
      line_items: o.lines.map((l, n) => ({
        id: n + 1,
        product_id: productIdAt(l.productPick),
        variation_id: 0,
        name: `line ${n}`,
        quantity: l.qty,
        price: l.priceCents / 100,
        subtotal: money(l.priceCents * l.qty),
        total: money(l.priceCents * l.qty),
        sku: '',
      })),
      shipping_lines: [{ method_title: 'Flat Rate', total: money(o.shipCents) }],
      tax_lines: [{ label: 'VAT', tax_total: money(o.taxCents) }],
      discount_total: money(o.discountCents),
      shipping_total: money(o.shipCents),
      total_tax: money(o.taxCents),
      // Money taken is the whole total and a refund never exceeds it: the order mapper captures and refunds `total`.
      total: money(o.totalCents),
      customer_note: o.note,
      meta_data: [],
      payment_method: 'stripe',
    }
  })

  const reviews: Rec[] = d.reviews.map((r, i) => ({
    id: i + 1,
    product_id: productIdAt(r.productPick),
    reviewer: `reviewer${i + 1}`,
    reviewer_email: `r${i + 1}@example.com`,
    review: r.text,
    rating: r.rating,
    verified: false,
    date_created: '2024-03-01T09:00:00',
  }))

  return { categories, products, variations, customers, orders, reviews }
}
