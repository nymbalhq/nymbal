import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalFsMediaStorage } from '@nymbalhq/platform'
import type { WooCommerceImportOptions } from '@nymbalhq/importers'
import type { buildImportEnv } from './import-env.js'

// The WooCommerce stores recorded under fixtures/recorded/<store>/ (each answer verbatim, with manifest.json naming
// the request, its status and its X-WP-Total), served by a fetch mock at the store's own home_url as WooCommerce
// served them, and the test's own reading of what WooCommerce said: money parsed here, never by the mapper.

export type Rec = Record<string, unknown>
export type RecordedStoreName = 'store-a-gbp' | 'store-b-jpy'
export const RECORDED_STORES: readonly RecordedStoreName[] = ['store-a-gbp', 'store-b-jpy']

const RECORDED = fileURLToPath(new URL('../fixtures/recorded', import.meta.url))
const API = '/wp-json/wc/v3'

export interface RecordedStore {
  name: RecordedStoreName
  homeUrl: string
  currency: string
  settings: Record<string, string>
  products: Rec[]
  /** Each variable product's variations as WooCommerce answered them, by product id. */
  variations: Record<number, Rec[]>
  categories: Rec[]
  /** The X-WP-Total WooCommerce sent with each answer, by file. */
  totals: Record<string, number>
  answer(file: string): unknown
}

export function loadRecordedStore(name: RecordedStoreName): RecordedStore {
  const dir = join(RECORDED, name)
  const answer = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const manifest = answer('manifest.json') as {
    homeUrl: string
    settings: Record<string, string>
    record: { answers: Array<{ file: string; 'X-WP-Total': string | null }> }
  }
  const products = answer('products.page-1.json') as Rec[]
  const variations: Record<number, Rec[]> = {}
  for (const p of products) {
    const file = `products-${p['id'] as number}-variations.json`
    if (existsSync(join(dir, file))) variations[p['id'] as number] = answer(file) as Rec[]
  }
  const totals: Record<string, number> = {}
  for (const a of manifest.record.answers) {
    if (a['X-WP-Total'] !== null) totals[a.file] = Number(a['X-WP-Total'])
  }
  return {
    name,
    homeUrl: manifest.homeUrl,
    currency: manifest.settings['woocommerce_currency']!,
    settings: manifest.settings,
    products,
    variations,
    categories: answer('categories.json') as Rec[],
    totals,
    answer,
  }
}

/** A minimal PNG: the importer stores what it is sent, typed by its header. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

export interface RecordedFetchOptions {
  /** Answers a request before the recording does: `path` is under /wp-json/wc/v3, `page` the requested page. */
  override?: (path: string, page: number) => Response | undefined
  /** Serves the products over pages of this size instead of the one page WooCommerce answered. */
  productsPerPage?: number
}

export interface RecordedMock {
  fetch: typeof fetch
  /** Every request, in order: its path and `page`. */
  requests: Array<{ path: string; page: number }>
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** fetch over a recorded store at its home_url: the API answers, and image bytes for /wp-content/uploads/*. */
export function recordedFetch(store: RecordedStore, opts: RecordedFetchOptions = {}): RecordedMock {
  const origin = new URL(store.homeUrl).origin
  const requests: RecordedMock['requests'] = []
  const list = (items: Rec[], page: number, perPage: number) => {
    const pages = Math.max(1, Math.ceil(items.length / perPage))
    return json(items.slice((page - 1) * perPage, page * perPage), 200, {
      'X-WP-Total': String(items.length),
      'X-WP-TotalPages': String(pages),
    })
  }
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const u = new URL(href)
    const page = Number(u.searchParams.get('page') ?? '1')
    const path = u.pathname.startsWith(`${API}/`) ? u.pathname.slice(API.length) : u.pathname
    requests.push({ path, page })
    if (u.origin !== origin) return new Response('not found', { status: 404 })
    if (u.pathname.startsWith('/wp-content/uploads/')) {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    if (!u.pathname.startsWith(`${API}/`)) return json({ code: 'rest_no_route' }, 404)
    const overridden = opts.override?.(path, page)
    if (overridden !== undefined) return overridden
    if (path === '/system_status') return json(store.answer('system_status.json'))
    if (path === '/settings/general') return json(store.answer('settings-general.json'))
    if (path === '/settings/products') return json(store.answer('settings-products.json'))
    if (path === '/products/categories') return list(store.categories, page, 100)
    if (path === '/products') return list(store.products, page, opts.productsPerPage ?? 100)
    const variations = /^\/products\/(\d+)\/variations$/.exec(path)
    if (variations) {
      const items = store.variations[Number(variations[1])]
      return items === undefined
        ? json({ code: 'woocommerce_rest_product_invalid_id' }, 404)
        : list(items, page, 100)
    }
    if (path === '/customers' || path === '/orders' || path === '/products/reviews')
      return list([], page, 100)
    return json({ code: 'rest_no_route' }, 404)
  }
  return { fetch: fetchImpl as typeof fetch, requests }
}

/** The fraction digits of a currency's minor units, as the platform formats them. */
export function currencyDigits(currency: string): number {
  return (
    new Intl.NumberFormat('en-GB', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  )
}

/** A WooCommerce price string in minor units, rounding half up past the currency's digits; null when empty. */
export function minorUnits(price: string, currency: string): number | null {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(price.trim())
  if (m === null) return null
  const digits = currencyDigits(currency)
  const fraction = (m[2] ?? '').padEnd(digits + 1, '0')
  const kept = Number(`${m[1]}${fraction.slice(0, digits)}`)
  return kept + (Number(fraction[digits]) >= 5 ? 1 : 0)
}

export type ImportEnv = Awaited<ReturnType<typeof buildImportEnv>>
export type ImportedProduct = Awaited<ReturnType<ImportEnv['services']['product']['getById']>>

/** Each product the import created, by WooCommerce id, read back through the product service. */
export async function importedProducts(
  env: ImportEnv,
  statePath: string,
): Promise<Map<number, ImportedProduct>> {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    wcToNymbalProduct: Record<string, string>
  }
  const out = new Map<number, ImportedProduct>()
  for (const [wcId, id] of Object.entries(state.wcToNymbalProduct)) {
    out.set(Number(wcId), await env.services.product.getById(id))
  }
  return out
}

/** The options `nymbal import` passes for a recorded store, its own home_url as the WooCommerce URL. */
export function recordedImportOptions(
  store: RecordedStore,
  projectRoot: string,
  overrides: Partial<WooCommerceImportOptions> & { untrackedStock?: number } = {},
): WooCommerceImportOptions {
  return {
    credentials: { url: store.homeUrl, consumerKey: 'key', consumerSecret: 'secret' },
    entities: ['categories' as const, 'products' as const],
    ai: false,
    gdpr: false,
    fresh: true,
    concurrency: 1,
    projectRoot,
    currency: store.currency,
    statePath: join(projectRoot, '.nymbal-migration.json'),
    ...overrides,
  }
}

export function localMedia(projectRoot: string) {
  return createLocalFsMediaStorage({
    root: join(projectRoot, 'public', 'imported-media'),
    urlPrefix: '/imported-media',
  })
}
