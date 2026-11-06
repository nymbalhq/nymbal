import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import {
  loadState,
  runWooCommerceImport,
  type ImportEntity,
  type WooCommerceImporterDeps,
} from '@nymbalhq/importers'
import { WC_URL } from './import-env.js'
import {
  ALL_ENTITIES,
  importDeps,
  importOptions,
  type ImportRun,
  type StoreApp,
} from './store-app.js'
import { wooStoreFetch, type RecordedRequest, type Rec, type WooStore } from './woo-store.js'

// A WooCommerce source that changes after an import, served as WooCommerce lists what changed: `/products` and
// `/orders` keep only records whose `date_modified_gmt` is after `modified_after`, `/products/reviews` only those whose
// `date_created_gmt` is after `after`; every other list is served whole. A record with no date is old. A request can
// be held forever (a process stopped there) or failed with a server error, and every request is recorded with its full
// URL.

/** When a record of the source as imported was last changed: before any `since` a test uses. */
export const LONG_AGO = '2024-01-01T00:00:00'
/** When a changed record was changed: after every `since` a test uses. */
export const CHANGED_AT = '2099-01-01T00:00:00'
export const SINCE = '2026-10-01T00:00:00Z'

export type SinceByEntity = Partial<Record<ImportEntity, string | null>>

/** The same `since` for every entity. */
export const sinceForAll = (since: string): SinceByEntity =>
  Object.fromEntries(ALL_ENTITIES.map((e) => [e, since])) as SinceByEntity

const API = '/wp-json/wc/v3'

/** A WooCommerce date parameter as an instant: with no zone it is read as UTC. */
function instant(value: string): number {
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`)
}

const dated = (r: Rec, key: string): number => instant(String(r[key] ?? LONG_AGO))

/** What `store` lists for the request at `u`. */
function listedFor(store: WooStore, u: URL): WooStore {
  const modifiedAfter = u.searchParams.get('modified_after')
  const after = u.searchParams.get('after')
  const changed = (items: Rec[]) =>
    modifiedAfter === null
      ? items
      : items.filter((r) => dated(r, 'date_modified_gmt') > instant(modifiedAfter))
  return {
    ...store,
    products: changed(store.products),
    orders: changed(store.orders),
    reviews:
      after === null
        ? store.reviews
        : store.reviews.filter((r) => dated(r, 'date_created_gmt') > instant(after)),
  }
}

export interface DeltaMock {
  fetch: typeof fetch
  requests: RecordedRequest[]
  /** Resolves when the first held request arrives. */
  held: Promise<void>
}

/** fetch over `store` as each request finds it; a request `hold` picks never answers, one `fail` picks is a 500. */
export function deltaStoreFetch(
  store: WooStore,
  opts: { hold?: (u: URL) => boolean; fail?: (u: URL) => boolean } = {},
): DeltaMock {
  const requests: RecordedRequest[] = []
  let reached!: () => void
  const held = new Promise<void>((resolve) => {
    reached = resolve
  })
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const u = new URL(href)
    requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url: href, path: u.pathname })
    if (opts.hold?.(u)) {
      reached()
      return new Promise<Response>(() => undefined)
    }
    if (opts.fail?.(u)) return new Response('internal error', { status: 500 })
    return wooStoreFetch(listedFor(store, u)).fetch(input, init)
  }
  return { fetch: fetchImpl as typeof fetch, requests, held }
}

/** The API resource a request is for: `/products/<id>/variations` as `/products/:id/variations`; null for an image. */
export function resourceOf(r: RecordedRequest): string | null {
  if (!r.path.startsWith(`${API}/`)) return null
  return r.path
    .slice(API.length)
    .replace(/^\/products\/\d+\/variations$/, '/products/:id/variations')
}

/** The date parameters a request carried, null when absent. */
export function dateParams(r: RecordedRequest): {
  modified_after: string | null
  after: string | null
  dates_are_gmt: string | null
} {
  const q = new URL(r.url).searchParams
  return {
    modified_after: q.get('modified_after'),
    after: q.get('after'),
    dates_are_gmt: q.get('dates_are_gmt'),
  }
}

export interface DeltaRunOptions extends ImportRun {
  since?: SinceByEntity
  ai?: boolean
  hold?: (u: URL) => boolean
  fail?: (u: URL) => boolean
}

/** One run of the importer over `run.store` with `since` (none: a plain run, which resumes a delta pass). */
export async function runOver(
  env: StoreApp,
  run: DeltaRunOptions,
  deps: WooCommerceImporterDeps = importDeps(env),
) {
  const mock = deltaStoreFetch(run.store, {
    ...(run.hold !== undefined && { hold: run.hold }),
    ...(run.fail !== undefined && { fail: run.fail }),
  })
  vi.stubGlobal('fetch', mock.fetch)
  const options = {
    ...importOptions(env, run),
    ai: run.ai ?? false,
    ...(run.since !== undefined && { since: run.since }),
  }
  const result = runWooCommerceImport(options, deps)
  if (run.hold === undefined) {
    try {
      return { report: await result, requests: mock.requests }
    } finally {
      vi.unstubAllGlobals()
    }
  }
  result.catch(() => undefined)
  await Promise.race([mock.held, result])
  vi.unstubAllGlobals()
  return { report: null, requests: mock.requests }
}

/** The state file as JSON, with the fields this task adds read loosely. */
export async function stateOf(env: StoreApp) {
  const state = await loadState(env.statePath)
  if (state === null) throw new Error(`no state at ${env.statePath}`)
  return state as typeof state & {
    runs?: Array<{
      startedAt: string
      finishedAt: string
      since?: SinceByEntity
      entities?: ImportEntity[]
    }>
    delta?: { since: SinceByEntity; startedAt: string } & Record<string, unknown>
    warnings?: Array<{ phase: string; id?: string; message: string }>
  }
}

/** A `since` sent to the API: the instant floored to the second, `YYYY-MM-DDTHH:MM:SSZ`. */
export const toSecond = (iso: string): string => `${new Date(iso).toISOString().slice(0, 19)}Z`

/** The media key's file name the importer stores an image `src` under. */
export const imageFile = (src: string, ext = 'jpg'): string =>
  `${createHash('sha256').update(src).digest('hex').slice(0, 16)}.${ext}`

// ── Records ───────────────────────────────────────────────────────────────────────────────────────────────────────

const money = (cents: number) => (cents / 100).toFixed(2)

export function simpleProduct(id: number, over: Rec = {}): Rec {
  return {
    id,
    name: `product ${id}`,
    slug: `p-${id}`,
    type: 'simple',
    status: 'publish',
    description: `about product ${id}`,
    short_description: '',
    sku: `SKU-${id}`,
    regular_price: money(1000 + id),
    sale_price: '',
    categories: [],
    images: [],
    attributes: [],
    variations: [],
    meta_data: [],
    downloadable: false,
    virtual: false,
    weight: '1',
    dimensions: { length: '20', width: '15', height: '5' },
    date_modified_gmt: LONG_AGO,
    ...over,
  }
}

export function variation(id: number, over: Rec = {}): Rec {
  return {
    id,
    sku: `V-${id}`,
    regular_price: '12.00',
    sale_price: '',
    stock_quantity: 10,
    status: 'publish',
    attributes: [{ id: 1, name: 'Size', option: `s${id}` }],
    weight: '0.5',
    dimensions: { length: '10', width: '10', height: '2' },
    ...over,
  }
}

export function category(id: number, over: Rec = {}): Rec {
  return {
    id,
    name: `category ${id}`,
    slug: `cat-${id}`,
    parent: 0,
    description: '',
    count: 0,
    ...over,
  }
}

export function customer(id: number): Rec {
  const email = `c${id}@example.com`
  const address = {
    first_name: `fn${id}`,
    last_name: `ln${id}`,
    company: '',
    address_1: `${id} high street`,
    address_2: '',
    city: 'leeds',
    state: 'yorkshire',
    postcode: `ls${id}`,
    country: 'GB',
    phone: `0113${id}`,
  }
  return {
    id,
    email,
    first_name: `fn${id}`,
    last_name: `ln${id}`,
    username: `user${id}`,
    billing: { ...address, email },
    shipping: address,
    meta_data: [],
    date_created: '2024-01-15T10:00:00',
  }
}

export function order(id: number, productId: number, customerId: number, over: Rec = {}): Rec {
  const address = {
    first_name: `fo${id}`,
    last_name: `lo${id}`,
    company: '',
    address_1: `${id} low street`,
    address_2: '',
    city: 'york',
    state: 'yorkshire',
    postcode: `yo${id}`,
    country: 'GB',
    phone: `0190${id}`,
  }
  return {
    id,
    number: String(id),
    status: 'completed',
    currency: 'GBP',
    date_created: '2024-02-01T12:00:00',
    date_modified_gmt: LONG_AGO,
    customer_id: customerId,
    billing: { ...address, email: `buyer${id}@example.com` },
    shipping: address,
    line_items: [
      {
        id: 1,
        product_id: productId,
        variation_id: 0,
        name: `line of ${id}`,
        quantity: 1,
        price: 10,
        subtotal: '10.00',
        total: '10.00',
        sku: '',
      },
    ],
    shipping_lines: [{ method_title: 'Flat Rate', total: '2.00' }],
    tax_lines: [{ label: 'VAT', tax_total: '2.00' }],
    discount_total: '0.00',
    shipping_total: '2.00',
    total_tax: '2.00',
    total: '14.00',
    customer_note: '',
    meta_data: [],
    payment_method: 'stripe',
    ...over,
  }
}

export function review(id: number, productId: number, over: Rec = {}): Rec {
  return {
    id,
    product_id: productId,
    reviewer: `reviewer${id}`,
    reviewer_email: `r${id}@example.com`,
    review: `review ${id}`,
    rating: 4,
    verified: false,
    date_created: '2024-03-01T09:00:00',
    date_created_gmt: '2024-03-01T09:00:00',
    ...over,
  }
}

/** An image the source store serves bytes for. */
export const servedImage = (name: string, alt: string): Rec => ({
  id: 0,
  src: `${WC_URL}/img/${name}.jpg`,
  name,
  alt,
})
