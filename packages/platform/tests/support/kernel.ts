import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import type { Address } from '@nymbalhq/types'
import { createApp, type CreateAppOptions, type NymbalApp } from '../../src/app.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'

// A kernel built from `src/` through createApp (repositories, services, projections and the in-process bus, no HTTP),
// on a SQLite file in a temp dir or on a Postgres database the caller created. `target` is what a second connection
// opens to read committed state independently of the kernel.

export type Dialect = 'sqlite' | 'postgres'

export interface Kernel {
  dialect: Dialect
  config: NymbalConfig
  app: NymbalApp
  store: NymbalApp['platform']['commandStore']
  repos: NymbalApp['repos']
  services: NymbalApp['services']
  eventBus: NymbalApp['platform']['eventBus']
  publisher: NymbalApp['publisher']
  documentStore: NymbalApp['platform']['documentStore']
  logger: NymbalApp['platform']['logger']
  /** The SQLite file, or the Postgres URL. */
  target: string
  close(): Promise<void>
}

export const MIGRATIONS_ROOT = fileURLToPath(new URL('../../migrations', import.meta.url))

export function kernelConfig(dialect: Dialect): NymbalConfig {
  return nymbalConfigSchema.parse({
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: dialect,
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: {
      adapter: 'middleware',
      botProtection: { mode: 'off' },
      // The harness overrides the built-in login and register limits, so suites that log in many times from
      // 127.0.0.1 are not refused. Tests of the defaults remove these keys (`withoutAuthRateRules`).
      rateLimit: {
        '/api/auth/login': { requests: 1000, window: '1m', action: 'block' },
        '/api/auth/register': { requests: 1000, window: '1m', action: 'block' },
      },
    },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native', config: { transport: 'console' } },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3999, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  })
}

/** The kernel config with no user rule for login or register, so the built-in defaults apply. */
export function withoutAuthRateRules(config: NymbalConfig): NymbalConfig {
  const rateLimit = { ...config.security.rateLimit }
  delete rateLimit['/api/auth/login']
  delete rateLimit['/api/auth/register']
  return { ...config, security: { ...config.security, rateLimit } }
}

/**
 * `sqlitePath` reopens (or creates) a file the caller owns, so a test can stop one kernel and start another on the
 * same database; without it the kernel owns a temp dir and removes it on close.
 */
export async function createKernel(
  opts: (
    | { dialect: 'sqlite'; sqlitePath?: string }
    | { dialect: 'postgres'; postgresUrl: string }
  ) & {
    /** Reshapes the kernel config before anything opens, e.g. to serve a kernel on the Stripe adapter. */
    configure?: (config: NymbalConfig) => NymbalConfig
    /** More createApp options, beside the storage and logger the harness passes, e.g. injected adapters. */
    appOptions?: Omit<CreateAppOptions, 'sqlitePath' | 'postgresUrl' | 'logger'>
    /** The kernel's logger, for a test that reads what it logs; errors only by default. */
    logger?: Kernel['logger']
  },
): Promise<Kernel> {
  const base = kernelConfig(opts.dialect)
  const config = opts.configure === undefined ? base : opts.configure(base)
  const logger = opts.logger ?? createLogger({ pretty: false, level: 'error' })
  const ownedPath = opts.dialect === 'sqlite' ? opts.sqlitePath : undefined
  const dir =
    opts.dialect === 'sqlite' && ownedPath === undefined
      ? mkdtempSync(join(tmpdir(), 'txn-kernel-'))
      : undefined
  const target =
    opts.dialect === 'sqlite' ? (ownedPath ?? join(dir!, 'store.sqlite')) : opts.postgresUrl
  const storage = opts.dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }

  // createApp warms the document store from the tables, so they must exist before it runs.
  const migrateStore = createCommandStore(config, storage)
  try {
    await runMigrations(migrateStore, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await migrateStore.close()
  }

  // No wait before a retry unless a test asks for one, so a test that drains by hand after a failure retries at once.
  const relay = { retryDelayMs: 0, ...opts.appOptions?.relay }
  const app = await createApp(config, { ...opts.appOptions, relay, ...storage, logger })
  return {
    dialect: opts.dialect,
    config,
    app,
    store: app.platform.commandStore,
    repos: app.repos,
    services: app.services,
    eventBus: app.platform.eventBus,
    publisher: app.publisher,
    documentStore: app.platform.documentStore,
    logger,
    target,
    async close() {
      await app.stop()
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    },
  }
}

export const address: Address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

export interface Seeded {
  productId: string
  variantId: string
  priceMinor: number
  initialStock: number
}

/** One active product with one variant at `stock`, unique slug and sku. */
export async function seedVariant(
  kernel: { services: Pick<Kernel['services'], 'product'> },
  stock: number,
  opts: { priceMinor?: number; lowStockThreshold?: number } = {},
): Promise<Seeded> {
  const tag = randomUUID()
  const priceMinor = opts.priceMinor ?? 1000
  const product = await kernel.services.product.create({
    slug: `txn-${tag}`,
    name: 'Transactional Widget',
    description: '',
    status: 'active',
    variants: [
      {
        sku: `P102-${tag}`,
        name: 'Default',
        priceMinor,
        stock,
        lowStockThreshold: opts.lowStockThreshold ?? 0,
        options: [],
      },
    ],
  })
  return {
    productId: product.id,
    variantId: product.variants[0]!.id,
    priceMinor,
    initialStock: stock,
  }
}

/** A cart holding `qty` of the variant, through the cart service. */
export async function cartWith(
  kernel: { services: Pick<Kernel['services'], 'cart'> },
  seeded: Seeded,
  qty: number,
): Promise<string> {
  const cart = await kernel.services.cart.getOrCreate()
  await kernel.services.cart.addItem(cart.token, {
    variantId: seeded.variantId,
    productId: seeded.productId,
    productName: 'Transactional Widget',
    variantName: 'Default',
    priceMinor: seeded.priceMinor,
    imageUrl: '',
    qty,
  })
  return cart.token
}

/**
 * beginCheckout for a fresh cart of `qty`, through the services. The default buyer's `+stub-pending` address keeps the
 * order pending with its intent set, as a Stripe order is until its webhook: the suites built on this helper drive
 * the capture themselves. Pass an address without the trigger for a checkout the stub pays inline.
 */
export async function checkoutOf(
  kernel: Pick<Kernel, 'services'>,
  seeded: Seeded,
  qty: number,
  email = `buyer-${randomUUID()}+stub-pending@txn.test`,
) {
  const cartToken = await cartWith(kernel, seeded, qty)
  const started = await kernel.services.checkout.beginCheckout({
    cartToken,
    email,
    billingAddress: address,
    shippingAddress: address,
  })
  return { ...started, cartToken, email }
}
