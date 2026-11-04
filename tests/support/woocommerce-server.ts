import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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

export interface WooCommerceServerOptions {
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

export async function startWooCommerceServer(
  opts: WooCommerceServerOptions = {},
): Promise<WooCommerceServer> {
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
