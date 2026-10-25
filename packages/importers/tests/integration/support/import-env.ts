import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InMemoryDocumentStore,
  InProcessEventBus,
  createCommandStore,
  runMigrations,
  buildRepositories,
  createEventPublisher,
  createRelay,
  createProductService,
  createCategoryService,
  createAuthService,
  createOrderService,
  createNativeReviewsAdapter,
  createNativeSearchAdapter,
  createLogger,
  rawClients,
} from '@nymbalhq/platform'
import type { ServiceRegistry, Repositories } from '@nymbalhq/platform'
import type { Logger } from '@nymbalhq/types'
import { wirePublisher } from '../../../../platform/src/tests/publisher.js'

// The kernel the WooCommerce importer writes through (the platform's dist, as woocommerce-import.test.ts builds it),
// and a fetch mock of the WooCommerce API over the fixtures in which every product has several images, each with bytes
// and a content type of its own, so a test can tell which source image a put or a stored object came from. Requests
// to any other host go to the real fetch (an S3 server, for one).

const MIGRATIONS_ROOT = fileURLToPath(new URL('../../../../platform/migrations', import.meta.url))
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures', import.meta.url))
export const WC_URL = 'https://wc.example.com'

const IMAGE_TYPES = [
  { contentType: 'image/jpeg', ext: 'jpg' },
  { contentType: 'image/png', ext: 'png' },
  { contentType: 'image/webp', ext: 'webp' },
  { contentType: 'image/gif', ext: 'gif' },
] as const

export interface SourceImage {
  src: string
  bytes: Uint8Array
  contentType: string
}

export interface SourceProduct {
  id: number
  slug: string
  images: SourceImage[]
}

function fixture(name: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as Array<
    Record<string, unknown>
  >
}

/** The fixture products with `perProduct` images each, and what each image `src` serves. */
export function sourceCatalogue(perProduct = 3): {
  products: SourceProduct[]
  wcProducts: Array<Record<string, unknown>>
  images: Map<string, SourceImage>
} {
  const images = new Map<string, SourceImage>()
  const products: SourceProduct[] = []
  let n = 0
  const wcProducts = fixture('products').map((wc) => {
    const id = wc['id'] as number
    const own: SourceImage[] = []
    for (let i = 0; i < perProduct; i++) {
      const type = IMAGE_TYPES[n % IMAGE_TYPES.length]!
      const src = `${WC_URL}/img/${id}-${i + 1}.${type.ext}`
      const bytes = new TextEncoder().encode(`s3 source image ${src} #${n}\n`.repeat(1 + (n % 3)))
      const image = { src, bytes, contentType: type.contentType }
      images.set(src, image)
      own.push(image)
      n++
    }
    products.push({ id, slug: wc['slug'] as string, images: own })
    return {
      ...wc,
      images: own.map((img, i) => ({
        id: id * 100 + i,
        src: img.src,
        name: `${id}-${i + 1}`,
        alt: `image ${i + 1}`,
      })),
    }
  })
  return { products, wcProducts, images }
}

function json(data: unknown, total: number): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'X-WP-Total': String(total),
      'X-WP-TotalPages': '1',
    },
  })
}

/** fetch for the WooCommerce API at WC_URL and its images; anything else goes to `passthrough`. */
export function wooFetch(
  catalogue: ReturnType<typeof sourceCatalogue>,
  passthrough: typeof fetch,
): typeof fetch {
  const categories = fixture('categories')
  const variations = fixture('variations')
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!href.startsWith(`${WC_URL}/`)) return passthrough(input, init)
    const image = catalogue.images.get(href.split('?')[0]!)
    if (image !== undefined) {
      return new Response(new Uint8Array(image.bytes), {
        status: 200,
        headers: { 'content-type': image.contentType },
      })
    }
    const u = new URL(href)
    const path = u.pathname.replace('/wp-json/wc/v3', '')
    const first = (u.searchParams.get('page') ?? '1') === '1'
    const list = (items: unknown[]) => json(first ? items : [], items.length)
    if (path === '/system_status') return json({}, 1)
    if (path === '/products/categories') return list(categories)
    if (path === '/products') return list(catalogue.wcProducts)
    if (/^\/products\/\d+\/variations/.test(path)) return list(variations)
    if (path === '/customers' || path === '/orders' || path === '/products/reviews') return list([])
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

export async function buildImportEnv() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal test config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, { migrationsRoot: MIGRATIONS_ROOT })

  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger: Logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos: Repositories = buildRepositories(commandStore, documentStore)
  // The platform's dist factories: the store above comes from dist, and the outbox must share its module instance.
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
  const reviews = createNativeReviewsAdapter({ repos, logger })
  // The native search adapter is SQL over the command store's own database.
  const search = createNativeSearchAdapter({ sql: rawClients(commandStore), logger })
  const product = createProductService({
    store: commandStore,
    repos,
    publisher,
    logger,
    currency: 'GBP',
  })
  const category = createCategoryService({ repos, publisher, logger })
  const auth = createAuthService({
    repos,
    publisher,
    logger,
    jwtSecret: 'test-secret-32-chars-long-xxxxx',
    accessTtl: '15m',
    refreshTtl: '7d',
  })
  const order = createOrderService({
    store: commandStore,
    repos,
    publisher,
    logger,
    orderNumberPrefix: 'WC',
    orderNumberStart: 1,
  })
  const services = { product, category, auth, order, search } as unknown as ServiceRegistry
  return {
    commandStore,
    repos,
    services,
    adapters: { ai: null, reviews },
    async close() {
      await eventBus.close()
      await documentStore.close()
      await commandStore.close()
    },
  }
}

export function importOptions(projectRoot: string) {
  return {
    credentials: { url: WC_URL, consumerKey: 'ck_test', consumerSecret: 'cs_test' },
    entities: ['categories' as const, 'products' as const],
    ai: false,
    gdpr: false,
    fresh: true,
    concurrency: 1,
    projectRoot,
    currency: 'GBP',
    statePath: join(projectRoot, '.nymbal-migration.json'),
  }
}

/** Each imported product's media URLs in position order, by WooCommerce product id, read back from the kernel. */
export async function importedMedia(
  env: Awaited<ReturnType<typeof buildImportEnv>>,
  statePath: string,
): Promise<Map<number, string[]>> {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    wcToNymbalProduct: Record<string, string>
  }
  const out = new Map<number, string[]>()
  for (const [wcId, id] of Object.entries(state.wcToNymbalProduct)) {
    const product = await env.services.product.getById(id)
    out.set(
      Number(wcId),
      [...product.media].sort((a, b) => a.position - b.position).map((m) => m.url),
    )
  }
  return out
}
