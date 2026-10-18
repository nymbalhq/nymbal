import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import type { Address } from '@nymbalhq/types'
import { createApp, type NymbalApp } from '../../src/app.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'

// P1-02 acceptance support: a kernel built from `src/` through createApp (repositories, services, projections and
// the in-process bus, no HTTP), on a SQLite file in a temp dir or on a Postgres database the caller created.
// `target` is what a second connection opens to read committed state independently of the kernel.

export type Dialect = 'sqlite' | 'postgres'

export interface Kernel {
  dialect: Dialect
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
    store: { name: 'P1-02', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      cloud: 'local',
      commandStore: dialect,
      documentStore: 'in-memory',
      eventBus: 'in-process',
      compute: 'in-process',
    },
    security: { adapter: 'middleware', botProtection: { mode: 'off' } },
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

export async function createKernel(
  opts: { dialect: 'sqlite' } | { dialect: 'postgres'; postgresUrl: string },
): Promise<Kernel> {
  const config = kernelConfig(opts.dialect)
  const logger = createLogger({ pretty: false, level: 'error' })
  const dir = opts.dialect === 'sqlite' ? mkdtempSync(join(tmpdir(), 'p1-02-kernel-')) : undefined
  const target = opts.dialect === 'sqlite' ? join(dir!, 'store.sqlite') : opts.postgresUrl
  const storage = opts.dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }

  // createApp warms the document store from the tables, so they must exist before it runs.
  const migrateStore = createCommandStore(config, storage)
  try {
    await runMigrations(migrateStore, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await migrateStore.close()
  }

  const app = await createApp(config, { ...storage, logger })
  return {
    dialect: opts.dialect,
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
  kernel: Pick<Kernel, 'services'>,
  stock: number,
  opts: { priceMinor?: number; lowStockThreshold?: number } = {},
): Promise<Seeded> {
  const tag = randomUUID()
  const priceMinor = opts.priceMinor ?? 1000
  const product = await kernel.services.product.create({
    slug: `p1-02-${tag}`,
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
  kernel: Pick<Kernel, 'services'>,
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

/** beginCheckout for a fresh cart of `qty`, through the services. */
export async function checkoutOf(
  kernel: Pick<Kernel, 'services'>,
  seeded: Seeded,
  qty: number,
  email = `buyer-${randomUUID()}@p1-02.test`,
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
