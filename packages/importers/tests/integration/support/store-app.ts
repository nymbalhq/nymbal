import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import {
  createApp,
  createCommandStore,
  createLogger,
  diffReadModel,
  READ_MODEL_NAMES,
  runMigrations,
  type NymbalApp,
} from '@nymbalhq/platform'
import { runWooCommerceImport, type ImportEntity } from '@nymbalhq/importers'
import type { EmailAdapter, MediaStorage } from '@nymbalhq/types'
import { WC_URL } from './import-env.js'
import { wooStoreFetch, type WooStore } from './woo-store.js'
import {
  coveredTables,
  everyTable,
  readRows,
  type TableSnapshot,
} from '../../../../../tests/support/store-tables.js'

// A whole store on a SQLite file, built from the platform's dist through createApp (services, projections, the
// in-process bus and the read models it rebuilds at boot), as `nymbal import` runs it, so an import and a rollback can be
// compared row for row with what the store held before. A second, read-only connection reads the file.

const MIGRATIONS_ROOT = fileURLToPath(new URL('../../../../platform/migrations', import.meta.url))

export const ALL_ENTITIES: ImportEntity[] = [
  'categories',
  'products',
  'customers',
  'orders',
  'reviews',
]

export type { TableSnapshot }

export interface StoreApp {
  app: NymbalApp
  dir: string
  dbPath: string
  statePath: string
  /** The tables Decision 1 covers: every table but the append-only, counter and search-index ones. */
  covered(): TableSnapshot
  /** Every table but the search index's (a refused command writes to none of them). */
  everyTable(): TableSnapshot
  rows<T>(sql: string, ...params: unknown[]): T[]
  /** Per read model and collection, what a rebuild from the tables would change in the live documents. */
  readModelDifferences(): Promise<string[]>
  close(): Promise<void>
}

export interface StoreAppOptions {
  /** The store's email adapter, as the `custom` email provider (a recording one, say); the console one otherwise. */
  email?: EmailAdapter
}

export async function openStoreApp(opts: StoreAppOptions = {}): Promise<StoreApp> {
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-rollback-'))
  const dbPath = join(dir, 'store.db')
  const config = nymbalConfigSchema.parse({
    store: { name: 'rollback', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', botProtection: { mode: 'off' } },
    commerce: {
      payments: { provider: 'native' },
      email:
        opts.email === undefined
          ? { provider: 'native', config: { transport: 'console' } }
          : { provider: 'custom' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
      // The store's own first order is WC-1, which a source order numbered 1 collides with.
      orders: { numberPrefix: 'WC', numberStart: 0 },
    },
    http: { adapter: 'fastify', port: 3999, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  })
  const migrate = createCommandStore(config, { sqlitePath: dbPath })
  try {
    await runMigrations(migrate, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await migrate.close()
  }
  const logger = createLogger({ pretty: false, level: 'silent' })
  const app = await createApp(config, {
    sqlitePath: dbPath,
    logger,
    mediaRoot: join(dir, 'media'),
    relay: { retryDelayMs: 0 },
    ...(opts.email !== undefined && { adapters: { email: opts.email } }),
  })

  const rows = <T>(sql: string, ...params: unknown[]): T[] => readRows<T>(dbPath, sql, ...params)

  return {
    app,
    dir,
    dbPath,
    statePath: join(dir, '.nymbal-migration.json'),
    covered: () => coveredTables(dbPath),
    everyTable: () => everyTable(dbPath),
    rows,
    async readModelDifferences() {
      await app.relay.drain()
      const deps = {
        config,
        store: app.platform.commandStore,
        repos: app.repos,
        documentStore: app.platform.documentStore,
        search: app.adapters.search,
        logger,
      }
      const out: string[] = []
      for (const name of READ_MODEL_NAMES) {
        const diff = await diffReadModel(name, deps)
        for (const c of diff.collections) {
          if (c.added + c.changed + c.removed > 0) {
            out.push(`${name}/${c.name}: +${c.added} ~${c.changed} -${c.removed}`)
          }
        }
      }
      return out
    },
    async close() {
      await app.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Media the importer puts nowhere: what a product's images are stored as is not what a rollback is about. */
export const media: MediaStorage = {
  capabilities: () => ['put'],
  async put(key) {
    return { url: `/imported-media/${key}` }
  },
}

export interface ImportRun {
  store: WooStore
  entities?: ImportEntity[]
  gdpr?: boolean
  fresh?: boolean
  concurrency?: number
}

/** The import's options over the store app's project directory. */
export function importOptions(env: StoreApp, run: ImportRun) {
  return {
    credentials: { url: WC_URL, consumerKey: 'ck_test', consumerSecret: 'cs_test' },
    entities: run.entities ?? ALL_ENTITIES,
    ai: false,
    gdpr: run.gdpr ?? false,
    fresh: run.fresh ?? false,
    concurrency: run.concurrency ?? 1,
    projectRoot: env.dir,
    currency: 'GBP',
    statePath: env.statePath,
  }
}

/** The importer's deps over the store app; `services` and `reviews` may be wrapped by the caller. */
export function importDeps(
  env: StoreApp,
  over: {
    services?: NymbalApp['services']
    reviews?: NymbalApp['adapters']['reviews']
  } = {},
) {
  return {
    services: over.services ?? env.app.services,
    repos: env.app.repos,
    adapters: { ai: null, reviews: over.reviews ?? env.app.adapters.reviews },
    media,
  }
}

/** A whole import of `run.store`, its WooCommerce API answered by the store as data. */
export async function importStore(env: StoreApp, run: ImportRun) {
  vi.stubGlobal('fetch', wooStoreFetch(run.store).fetch)
  try {
    return await runWooCommerceImport(importOptions(env, run), importDeps(env))
  } finally {
    vi.unstubAllGlobals()
  }
}

/** Resolves once the wall clock has passed `iso`, so that what happens next is stamped strictly after it. */
export async function clockPast(iso: string): Promise<void> {
  const t = Date.parse(iso)
  while (Date.now() <= t) await new Promise((r) => setImmediate(r))
}

export interface Seeded {
  categoryIds: string[]
  productId: string
  variantId: string
  customerIds: string[]
  orderId: string
  orderNumber: string
  reviewId: string
}

/**
 * What a store holds before any import: categories and a product with variants whose slugs and SKUs the generated
 * sources draw from (`SLUG_POOL`, `SKU_POOL`), customers holding `EMAIL_POOL` addresses, a native checkout order
 * numbered WC-1 (`ORDER_NUMBER_POOL`), and a review. The clock is past all of it when this returns.
 */
export async function seedStore(env: StoreApp): Promise<Seeded> {
  const { services, adapters } = env.app
  const categoryIds: string[] = []
  for (const slug of ['summer-tee', 'red-cap', 'books', 'home']) {
    const c = await services.category.create({
      slug,
      name: `store ${slug}`,
      parentId: null,
      position: 0,
    })
    categoryIds.push(c.id)
  }
  const product = await services.product.create({
    slug: 'summer-tee',
    name: 'Store summer tee',
    description: 'the store’s own',
    status: 'active',
    categoryIds: categoryIds.slice(0, 2),
    variants: [
      {
        sku: 'SHARED-1',
        name: 'S',
        priceMinor: 1500,
        stock: 20,
        lowStockThreshold: 0,
        options: [],
      },
      {
        sku: 'summer-tee',
        name: 'M',
        priceMinor: 1500,
        stock: 20,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  await services.product.create({
    slug: 'red-cap',
    name: 'Store red cap',
    description: '',
    status: 'active',
    categoryIds: [categoryIds[1]!],
    variants: [
      {
        sku: 'red-cap',
        name: 'One size',
        priceMinor: 900,
        stock: 5,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  const customerIds: string[] = []
  for (const email of ['dup@example.com', 'twin@example.com']) {
    const { customer } = await services.auth.register({
      email,
      password: 'a long enough store password 42',
      firstName: 'Store',
      lastName: 'Customer',
    })
    customerIds.push(customer.id)
  }
  const variantId = product.variants[0]!.id
  const placed = await placeOrder(env, product.id, variantId)
  const review = await adapters.reviews.submitReview({
    productId: product.id,
    customerId: customerIds[0]!,
    orderId: null,
    author: null,
    rating: 4,
    title: '',
    body: 'the store’s own review',
  })
  await env.app.relay.drain()
  const [latest] = env.rows<{ at: string }>(
    `SELECT max(t) AS at FROM (
       SELECT max(created_at) AS t FROM orders UNION ALL SELECT max(submitted_at) FROM reviews
       UNION ALL SELECT max(created_at) FROM customers)`,
  )
  await clockPast(latest!.at)
  return {
    categoryIds,
    productId: product.id,
    variantId,
    customerIds,
    orderId: placed.orderId,
    orderNumber: placed.orderNumber,
    reviewId: review.review.id,
  }
}

/** A guest's native checkout of one unit of the variant. */
export async function placeOrder(env: StoreApp, productId: string, variantId: string) {
  const { services } = env.app
  const cart = await services.cart.getOrCreate()
  await services.cart.addItem(cart.token, {
    variantId,
    productId,
    productName: 'Store product',
    variantName: 'Default',
    priceMinor: 1500,
    imageUrl: '',
    qty: 1,
  })
  const address = {
    firstName: 'Ada',
    lastName: 'Buyer',
    addressLine1: '1 Main St',
    city: 'London',
    region: 'England',
    postalCode: 'E1 6AN',
    country: 'GB',
  }
  return services.checkout.beginCheckout({
    cartToken: cart.token,
    email: `guest-${cart.token.slice(0, 8)}@store.test`,
    billingAddress: address,
    shippingAddress: address,
  })
}
