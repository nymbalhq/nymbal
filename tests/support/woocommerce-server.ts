import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// An HTTP WooCommerce REST API (wp-json/wc/v3) over the importer's fixtures, for imports run through the CLI
// (P2-11 AC-5), where a fetch mock cannot reach. Every product's images are rewritten to images this server serves,
// `imagesPerProduct` of them, each with bytes and a content type of its own, so a test can tell which source image a
// stored object came from. Any request without Basic credentials is refused, as WooCommerce does.

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

export interface WooCommerceServer {
  /** The store URL to pass as `--url`: the API is under `${url}/wp-json/wc/v3`. */
  url: string
  products: ServedProduct[]
  /** Every image, by its `src`. */
  images: Map<string, ServedImage>
  close(): Promise<void>
}

function fixture(name: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Array<
    Record<string, unknown>
  >
}

/** Bytes no other image has: a marker naming the src, then a run derived from its hash. */
function bytesFor(src: string, index: number): Uint8Array {
  const marker = new TextEncoder().encode(`p2-11 image ${src}\n`)
  const tail = createHash('sha256').update(src).digest()
  const out = new Uint8Array(marker.length + tail.length * (1 + (index % 3)))
  out.set(marker)
  for (let at = marker.length; at < out.length; at += tail.length) out.set(tail, at)
  return out
}

export async function startWooCommerceServer(
  opts: { imagesPerProduct?: number } = {},
): Promise<WooCommerceServer> {
  const perProduct = opts.imagesPerProduct ?? 2
  const categories = fixture('categories')
  const variations = fixture('variations')
  const rawProducts = fixture('products')
  const images = new Map<string, ServedImage>()
  const products: ServedProduct[] = []
  let served: Array<Record<string, unknown>> = []

  const send = (res: ServerResponse, status: number, body: unknown, total?: number) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      ...(total !== undefined && { 'x-wp-total': String(total), 'x-wp-totalpages': '1' }),
    })
    res.end(JSON.stringify(body))
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://fixture.invalid')
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
    if (path === '/system_status') return send(res, 200, {}, 1)
    if (path === '/products/categories') return list(categories)
    if (path === '/products') return list(served)
    if (/^\/products\/\d+\/variations$/.test(path)) return list(variations)
    if (path === '/customers' || path === '/orders' || path === '/products/reviews') return list([])
    return send(res, 404, { code: 'rest_no_route' })
  }

  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  let n = 0
  served = rawProducts.map((wc) => {
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
    return {
      ...wc,
      images: own.map((img, i) => ({
        id: id * 100 + i,
        src: img.src,
        name: `${id}-${i + 1}`,
        alt: `image ${i + 1} of ${id}`,
      })),
    }
  })

  return {
    url: base,
    products,
    images,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
