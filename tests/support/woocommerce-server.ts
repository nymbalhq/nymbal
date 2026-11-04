import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// An HTTP WooCommerce REST API (wp-json/wc/v3) over the importer's fixtures, for imports run through the CLI, where a
// fetch mock cannot reach. Every product's images are rewritten to images this server serves, `imagesPerProduct` of
// them, each with bytes and a content type of its own, so a test can tell which source image a stored object came
// from. Any request without Basic credentials is refused, as WooCommerce does. Every request is logged (method and
// path). By default customers, orders and reviews are empty and coupons, taxes and shipping zones answer 404; a test
// that needs them says what they answer. Products and orders are listed as WooCommerce lists them under
// `modified_after` (their `date_modified_gmt`, none read as long ago), reviews under `after` (`date_created_gmt`); a
// test changes the source between runs through `source`.
//
// `recorded` serves one of the stores recorded under fixtures/recorded/ in place of the fixtures: every answer as
// WooCommerce gave it (categories, every products page, variations by product id, the settings, system_status, and the
// customers, orders, reviews, coupons, taxes and shipping zones the store recorded), paged by `page` and `per_page`
// with WooCommerce's totals headers. Each image `src` (products' and variations') moves to the same path on this
// server, which answers a 1x1 PNG a browser decodes; permalinks are kept as recorded. `failImages` answers 404 for
// every image of the products it names.

const FIXTURES = fileURLToPath(
  new URL('../../packages/importers/tests/integration/fixtures', import.meta.url),
)

/** The importer's supported types (packages/importers/src/woocommerce/media.ts), one per image in turn. */
const IMAGE_TYPES = [
  { contentType: 'image/jpeg', ext: 'jpg' },
  { contentType: 'image/png', ext: 'png' },
  { contentType: 'image/webp', ext: 'webp' },
  { contentType: 'image/gif', ext: 'gif' },
] as const

export interface ServedImage {
  src: string
  bytes: Uint8Array
  contentType: string
}

export interface ServedProduct {
  id: number
  slug: string
  name: string
  images: ServedImage[]
}

export interface ServedRequest {
  method: string
  /** The pathname, without the query. */
  path: string
}

/** A probe's answer: a list total in `X-WP-Total`, a JSON body as is, or a bare status. */
export type ProbeAnswer = { total: number } | { body: unknown } | { status: number }

export type RecordedStoreName = 'store-a-gbp' | 'store-b-jpy' | 'store-c-eur'

export interface WooCommerceServerOptions {
  /** Serves this recorded store instead of the fixtures; the fixture options below are then ignored. */
  recorded?: RecordedStoreName
  /** WooCommerce product ids whose images (the product's and its variations') answer 404. */
  failImages?: number[]
  imagesPerProduct?: number
  /** Served after the fixture categories. */
  extraCategories?: Array<Record<string, unknown>>
  /** Served after the fixture products; their images are rewritten as the fixtures' are. */
  extraProducts?: Array<Record<string, unknown>>
  customers?: Array<Record<string, unknown>>
  orders?: Array<Record<string, unknown>>
  reviews?: Array<Record<string, unknown>>
  coupons?: ProbeAnswer
  taxes?: ProbeAnswer
  shippingZones?: ProbeAnswer
}

export interface WooCommerceServer {
  /** The store URL to pass as `--url`: the API is under `${url}/wp-json/wc/v3`. */
  url: string
  products: ServedProduct[]
  /** Every image, by its `src`. */
  images: Map<string, ServedImage>
  /** Every request the server answered, in order; a test may empty it (`requests.length = 0`). */
  requests: ServedRequest[]
  /** The products (images rewritten) and orders as served: a test may replace or edit a record between runs. */
  source: { products: Array<Record<string, unknown>>; orders: Array<Record<string, unknown>> }
  close(): Promise<void>
}

export function fixture(name: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Array<
    Record<string, unknown>
  >
}

/** Bytes no other image has: a marker naming the src, then a run derived from its hash. */
function bytesFor(src: string, index: number): Uint8Array {
  const marker = new TextEncoder().encode(`s3 image ${src}\n`)
  const tail = createHash('sha256').update(src).digest()
  const out = new Uint8Array(marker.length + tail.length * (1 + (index % 3)))
  out.set(marker)
  for (let at = marker.length; at < out.length; at += tail.length) out.set(tail, at)
  return out
}

/** A WooCommerce date as an instant: a value with no zone is UTC, no value is long ago. */
function instant(value: unknown): number {
  if (typeof value !== 'string') return Date.parse('2024-01-01T00:00:00Z')
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`)
}

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

type Rec = Record<string, unknown>

/** A recorded store's answers, read from its directory: the file a request was recorded in, or undefined. */
function recordedAnswers(name: RecordedStoreName): {
  products: Rec[]
  answer: (file: string) => unknown
} {
  const dir = join(FIXTURES, 'recorded', name)
  const answer = (file: string): unknown =>
    existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : undefined
  const pages = readdirSync(dir)
    .map((file) => /^products\.page-(\d+)\.json$/.exec(file))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  return { products: pages.flatMap((m) => answer(m[0]) as Rec[]), answer }
}

async function startRecordedServer(
  name: RecordedStoreName,
  failImages: readonly number[],
): Promise<WooCommerceServer> {
  const recording = recordedAnswers(name)
  const requests: ServedRequest[] = []
  const imagePaths = new Set<string>()
  const failedPaths = new Set<string>()
  let base = ''

  const moved = (image: unknown, failed: boolean): unknown => {
    if (typeof image !== 'object' || image === null) return image
    const src = (image as Rec)['src']
    if (typeof src !== 'string' || src === '') return image
    const path = new URL(src).pathname
    imagePaths.add(path)
    if (failed) failedPaths.add(path)
    return { ...(image as Rec), src: `${base}${path}` }
  }

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://fixture.invalid')
    requests.push({ method: req.method ?? 'GET', path: u.pathname })
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    if (imagePaths.has(u.pathname)) {
      if (failedPaths.has(u.pathname)) return send(404, { code: 'not_found' })
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) })
      res.end(PNG)
      return
    }
    if (!u.pathname.startsWith('/wp-json/wc/v3/')) return send(404, { code: 'rest_no_route' })
    if (!(req.headers.authorization ?? '').startsWith('Basic ')) {
      return send(401, { code: 'woocommerce_rest_cannot_view' })
    }
    const path = u.pathname.slice('/wp-json/wc/v3'.length)
    const page = Number(u.searchParams.get('page') ?? '1')
    const perPage = Number(u.searchParams.get('per_page') ?? '100')
    const list = (items: unknown[]) =>
      send(200, items.slice((page - 1) * perPage, page * perPage), {
        'x-wp-total': String(items.length),
        'x-wp-totalpages': String(Math.max(1, Math.ceil(items.length / perPage))),
      })
    const recorded = (file: string, orElse: () => void) => {
      const body = recording.answer(file)
      if (body === undefined) return orElse()
      return Array.isArray(body) ? list(body) : send(200, body)
    }
    const none = () => send(404, { code: 'rest_no_route' })
    if (path === '/system_status') return recorded('system_status.json', none)
    if (path === '/settings/general') return recorded('settings-general.json', none)
    if (path === '/settings/products') return recorded('settings-products.json', none)
    if (path === '/products/categories') return list(categories)
    if (path === '/products') return list(products)
    const variationsOf = /^\/products\/(\d+)\/variations$/.exec(path)
    if (variationsOf) {
      const items = variations.get(Number(variationsOf[1]))
      return items === undefined
        ? send(404, { code: 'woocommerce_rest_product_invalid_id' })
        : list(items)
    }
    if (path === '/customers') return recorded('customers.json', () => list([]))
    if (path === '/orders') return recorded('orders.json', () => list([]))
    if (path === '/products/reviews') return recorded('reviews.json', () => list([]))
    if (path === '/coupons') return recorded('coupons.json', none)
    if (path === '/taxes') return recorded('taxes.json', none)
    if (path === '/shipping/zones') return recorded('shipping-zones.json', none)
    return none()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const categories = recording.answer('categories.json') as Rec[]
  const variations = new Map<number, Rec[]>()
  const products: Rec[] = []
  const served: ServedProduct[] = []
  const images = new Map<string, ServedImage>()
  for (const wc of recording.products) {
    const id = wc['id'] as number
    const failed = failImages.includes(id)
    const own = ((wc['images'] as unknown[] | undefined) ?? []).map((i) => moved(i, failed))
    products.push({ ...wc, images: own })
    const recordedVariations = recording.answer(`products-${id}-variations.json`) as
      | Rec[]
      | undefined
    if (recordedVariations !== undefined) {
      variations.set(
        id,
        recordedVariations.map((v) => ({ ...v, image: moved(v['image'], failed) })),
      )
    }
    const servedImages = (own as Rec[])
      .filter((i) => typeof i['src'] === 'string' && i['src'] !== '')
      .map((i) => ({ src: i['src'] as string, bytes: new Uint8Array(PNG), contentType: 'image/png' }))
    for (const image of servedImages) images.set(image.src, image)
    served.push({ id, slug: wc['slug'] as string, name: wc['name'] as string, images: servedImages })
  }

  return {
    url: base,
    products: served,
    images,
    requests,
    source: { products, orders: (recording.answer('orders.json') as Rec[] | undefined) ?? [] },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

export async function startWooCommerceServer(
  opts: WooCommerceServerOptions = {},
): Promise<WooCommerceServer> {
  if (opts.recorded !== undefined) return startRecordedServer(opts.recorded, opts.failImages ?? [])
  const perProduct = opts.imagesPerProduct ?? 2
  const categories = [...fixture('categories'), ...(opts.extraCategories ?? [])]
  const variations = fixture('variations')
  const rawProducts = [...fixture('products'), ...(opts.extraProducts ?? [])]
  const images = new Map<string, ServedImage>()
  const products: ServedProduct[] = []
  const requests: ServedRequest[] = []
  const served: Array<Record<string, unknown>> = []
  const orders = [...(opts.orders ?? [])]

  const send = (res: ServerResponse, status: number, body: unknown, total?: number) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      ...(total !== undefined && { 'x-wp-total': String(total), 'x-wp-totalpages': '1' }),
    })
    res.end(JSON.stringify(body))
  }

  const probe = (res: ServerResponse, answer: ProbeAnswer | undefined) => {
    if (answer === undefined) return send(res, 404, { code: 'rest_no_route' })
    if ('total' in answer) return send(res, 200, answer.total > 0 ? [{ id: 1 }] : [], answer.total)
    if ('body' in answer) return send(res, 200, answer.body)
    return send(res, answer.status, { code: 'woocommerce_rest_cannot_view' })
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://fixture.invalid')
    requests.push({ method: req.method ?? 'GET', path: u.pathname })
    const image = images.get(`${base}${u.pathname}`)
    if (image !== undefined) {
      res.writeHead(200, {
        'content-type': image.contentType,
        'content-length': String(image.bytes.length),
      })
      res.end(Buffer.from(image.bytes))
      return
    }
    if (!u.pathname.startsWith('/wp-json/wc/v3/')) return send(res, 404, { code: 'rest_no_route' })
    if (!(req.headers.authorization ?? '').startsWith('Basic ')) {
      return send(res, 401, { code: 'woocommerce_rest_cannot_view' })
    }
    const path = u.pathname.slice('/wp-json/wc/v3'.length)
    const page = Number(u.searchParams.get('page') ?? '1')
    const list = (items: unknown[]) => send(res, 200, page === 1 ? items : [], items.length)
    const after = (param: string, field: string, items: Array<Record<string, unknown>>) => {
      const since = u.searchParams.get(param)
      return since === null ? items : items.filter((r) => instant(r[field]) > instant(since))
    }
    if (path === '/system_status') return send(res, 200, {}, 1)
    if (path === '/products/categories') return list(categories)
    if (path === '/products') return list(after('modified_after', 'date_modified_gmt', served))
    if (/^\/products\/\d+\/variations$/.test(path)) return list(variations)
    if (path === '/customers') return list(opts.customers ?? [])
    if (path === '/orders') return list(after('modified_after', 'date_modified_gmt', orders))
    if (path === '/products/reviews') {
      return list(after('after', 'date_created_gmt', opts.reviews ?? []))
    }
    if (path === '/coupons') return probe(res, opts.coupons)
    if (path === '/taxes') return probe(res, opts.taxes)
    if (path === '/shipping/zones') return probe(res, opts.shippingZones)
    return send(res, 404, { code: 'rest_no_route' })
  }

  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  let n = 0
  for (const wc of rawProducts) {
    const id = wc['id'] as number
    const own: ServedImage[] = []
    for (let i = 0; i < perProduct; i++) {
      const type = IMAGE_TYPES[n % IMAGE_TYPES.length]!
      const src = `${base}/img/${id}-${i + 1}.${type.ext}`
      const image = { src, bytes: bytesFor(src, n), contentType: type.contentType }
      images.set(src, image)
      own.push(image)
      n++
    }
    products.push({
      id,
      slug: wc['slug'] as string,
      name: wc['name'] as string,
      images: own,
    })
    served.push({
      ...wc,
      images: own.map((img, i) => ({
        id: id * 100 + i,
        src: img.src,
        name: `${id}-${i + 1}`,
        alt: `image ${i + 1} of ${id}`,
      })),
    })
  }

  return {
    url: base,
    products,
    images,
    requests,
    source: { products: served, orders },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
