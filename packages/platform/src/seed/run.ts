import { inArray } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import bcrypt from 'bcryptjs'
const { hashSync } = bcrypt
import type {
  DocumentStoreAdapter,
  EventBusAdapter,
  Logger,
  MediaStorage,
  NymbalEvent,
  Role,
  SearchAdapter,
} from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import { rawClients, type CommandStore } from '../db/command-store.js'
import { createCategoryRepository } from '../db/repositories/categories.js'
import { createProductRepository } from '../db/repositories/products.js'
import { createEventBuilder } from '../events/builder.js'
import { EVT_CATEGORY_CREATED, EVT_PRODUCT_CREATED, EVT_CUSTOMER_CREATED } from '@nymbalhq/types'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { seedCategories, seedImage, seedProducts, type SeedProduct } from './data.js'
import { buildRepositories } from '../repositories/index.js'
import { READ_MODEL_NAMES, rebuild } from '../read-models/index.js'

export interface SeedDeps {
  config: NymbalConfig
  commandStore: CommandStore
  documentStore: DocumentStoreAdapter
  eventBus: EventBusAdapter
  logger: Logger
  version: string
  /**
   * When given, each product's image is generated and written here, and the product points at the stored copy
   * instead of the third-party placeholder host: a store measured or run offline then serves its own images.
   */
  media?: MediaStorage
  /** The search index to rebuild with the document store; without it the next start's rebuild fills it. */
  search?: SearchAdapter
}

export interface SeedResult {
  categories: number
  products: number
  variants: number
  customers: number
  admins: number
  /** True when any demo row was already in the command store, so nothing was inserted. */
  alreadySeeded: boolean
}

async function insertVariants(
  store: CommandStore,
  rows: Array<{
    id: string
    productId: string
    sku: string
    name: string
    priceMinor: number
    stock: number
    options: unknown[]
    createdAt: Date
    updatedAt: Date
  }>,
): Promise<void> {
  if (rows.length === 0) return
  const clients = rawClients(store)
  if (clients.kind === 'sqlite') {
    const values = rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      sku: r.sku,
      name: r.name,
      priceMinor: r.priceMinor,
      compareAtPriceMinor: null,
      weightGrams: null,
      dimensions: null,
      stock: r.stock,
      lowStockThreshold: 3,
      options: JSON.stringify(r.options),
      status: 'active' as const,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
    clients.db.insert(sqliteSchema.variants).values(values).run()
    return
  }
  const values = rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    sku: r.sku,
    name: r.name,
    priceMinor: r.priceMinor,
    compareAtPriceMinor: null,
    weightGrams: null,
    dimensions: null,
    stock: r.stock,
    lowStockThreshold: 3,
    options: r.options,
    status: 'active' as const,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
  await clients.db.insert(postgresSchema.variants).values(values)
}

async function insertProductCategories(
  store: CommandStore,
  rows: Array<{ productId: string; categoryId: string }>,
): Promise<void> {
  if (rows.length === 0) return
  const clients = rawClients(store)
  if (clients.kind === 'sqlite') {
    clients.db.insert(sqliteSchema.productCategories).values(rows).run()
    return
  }
  await clients.db.insert(postgresSchema.productCategories).values(rows)
}

/**
 * Any demo row (category slug, product slug, seeded customer email) means an earlier seed ran, in full or in part.
 * Each is unique, so inserting the demo again would fail on the first collision: skip instead.
 */
async function demoRowsPresent(store: CommandStore, emails: string[]): Promise<boolean> {
  const categorySlugs = seedCategories.map((c) => c.slug)
  const productSlugs = seedProducts.map((p) => p.slug)
  const clients = rawClients(store)
  if (clients.kind === 'sqlite') {
    const { categories, products, customers } = sqliteSchema
    return (
      clients.db
        .select({ id: categories.id })
        .from(categories)
        .where(inArray(categories.slug, categorySlugs))
        .limit(1)
        .all().length > 0 ||
      clients.db
        .select({ id: products.id })
        .from(products)
        .where(inArray(products.slug, productSlugs))
        .limit(1)
        .all().length > 0 ||
      clients.db
        .select({ id: customers.id })
        .from(customers)
        .where(inArray(customers.email, emails))
        .limit(1)
        .all().length > 0
    )
  }
  const { categories, products, customers } = postgresSchema
  const [category, product, customer] = await Promise.all([
    clients.db
      .select({ id: categories.id })
      .from(categories)
      .where(inArray(categories.slug, categorySlugs))
      .limit(1),
    clients.db
      .select({ id: products.id })
      .from(products)
      .where(inArray(products.slug, productSlugs))
      .limit(1),
    clients.db
      .select({ id: customers.id })
      .from(customers)
      .where(inArray(customers.email, emails))
      .limit(1),
  ])
  return category.length > 0 || product.length > 0 || customer.length > 0
}

async function insertCustomer(
  store: CommandStore,
  row: {
    id: string
    email: string
    passwordHash: string
    firstName: string
    lastName: string
    roles?: Role[]
    createdAt: Date
    updatedAt: Date
  },
): Promise<void> {
  const roles = row.roles ?? ['customer']
  const clients = rawClients(store)
  if (clients.kind === 'sqlite') {
    clients.db
      .insert(sqliteSchema.customers)
      .values({
        id: row.id,
        email: row.email,
        passwordHash: row.passwordHash,
        firstName: row.firstName,
        lastName: row.lastName,
        phone: '',
        addresses: '[]',
        orderCount: 0,
        totalSpentMinor: 0,
        metadata: '{}',
        roles: JSON.stringify(roles),
        requiresPasswordReset: false,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })
      .run()
    return
  }
  await clients.db.insert(postgresSchema.customers).values({
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: '',
    addresses: [],
    orderCount: 0,
    totalSpentMinor: 0,
    metadata: {},
    roles,
    requiresPasswordReset: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

function failedOf(err: unknown): unknown {
  return (err as { context?: { failed?: unknown } }).context?.failed ?? []
}

export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
  const { config, commandStore, documentStore, eventBus, logger, version } = deps
  const categoryRepo = createCategoryRepository(commandStore)
  const productRepo = createProductRepository(commandStore)
  const makeEvent = createEventBuilder({
    storeId: config.store.name,
    environment: (process.env.NODE_ENV === 'production' ? 'production' : 'development') as
      | 'production'
      | 'development',
    version,
    source: 'nymbal-seed',
  })

  const demoEmail = 'demo@nymbal.dev'
  const adminEmail = process.env['NYMBAL_ADMIN_EMAIL'] ?? 'admin@nymbal.local'
  if (await demoRowsPresent(commandStore, [demoEmail, adminEmail])) {
    logger.info({}, 'Demo content already present, seed skipped')
    return { categories: 0, products: 0, variants: 0, customers: 0, admins: 0, alreadySeeded: true }
  }

  const now = new Date()

  // Categories
  const categoryInserts = seedCategories.map((c, i) => ({
    id: uuidv7(),
    slug: c.slug,
    name: c.name,
    description: c.description,
    parentId: null,
    position: i,
    createdAt: now,
  }))
  await categoryRepo.insertMany(categoryInserts)
  const categoryBySlug = new Map(categoryInserts.map((c) => [c.slug, c]))

  const imageUrls = new Map<string, string>()
  if (deps.media !== undefined) {
    for (const p of seedProducts) {
      const { url } = await deps.media.put(`seed/${p.slug}.svg`, seedImage(p), 'image/svg+xml')
      imageUrls.set(p.slug, url)
    }
  }

  // Products
  const productInserts = seedProducts.map((p) => ({
    id: uuidv7(),
    slug: p.slug,
    name: p.title,
    description: p.description,
    shortDescription: '',
    status: 'active' as const,
    type: 'simple' as const,
    seoTitle: p.title,
    seoDescription: p.description.slice(0, 160),
    media: [{ url: imageUrls.get(p.slug) ?? p.imageUrl, altText: p.title, position: 0 }],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  }))
  await productRepo.insertMany(productInserts)

  // Variants — one per product (simple type)
  const variantInserts = productInserts.map((p, i) => {
    const seed = seedProducts[i] as SeedProduct
    return {
      id: uuidv7(),
      productId: p.id,
      sku: p.slug.toUpperCase().replaceAll('-', '_'),
      name: 'Default',
      priceMinor: seed.priceMinor,
      stock: 25,
      options: [],
      createdAt: now,
      updatedAt: now,
    }
  })
  await insertVariants(commandStore, variantInserts)

  // Product ↔ Category joins
  const joinRows = productInserts.map((p, i) => {
    const seed = seedProducts[i] as SeedProduct
    const cat = categoryBySlug.get(seed.categorySlug)
    if (!cat) throw new Error(`Seed references unknown category: ${seed.categorySlug}`)
    return { productId: p.id, categoryId: cat.id }
  })
  await insertProductCategories(commandStore, joinRows)

  // Demo customer — password: nymbal
  const demoCustomer = {
    id: uuidv7(),
    email: demoEmail,
    passwordHash: hashSync('nymbal', 10),
    firstName: 'Demo',
    lastName: 'User',
    createdAt: now,
    updatedAt: now,
  }
  await insertCustomer(commandStore, demoCustomer)

  // Admin user — email and password from env, defaults for dev
  const adminPassword = process.env['NYMBAL_ADMIN_PASSWORD'] ?? 'nymbal-admin-dev'
  const adminRoles: Role[] = ['admin']
  const adminCustomer = {
    id: uuidv7(),
    email: adminEmail,
    passwordHash: hashSync(adminPassword, 10),
    firstName: 'Admin',
    lastName: 'User',
    roles: adminRoles,
    createdAt: now,
    updatedAt: now,
  }
  await insertCustomer(commandStore, adminCustomer)

  // Emit events
  const events = [
    ...categoryInserts.map((c) =>
      makeEvent(EVT_CATEGORY_CREATED, {
        category: {
          id: c.id,
          parentId: c.parentId,
          name: c.name,
          slug: c.slug,
          description: c.description,
          position: c.position,
          createdAt: now.toISOString(),
        },
      }),
    ),
    ...productInserts.map((p, i) => {
      const v = variantInserts[i]!
      const seed = seedProducts[i] as SeedProduct
      const cat = categoryBySlug.get(seed.categorySlug)!
      return makeEvent(EVT_PRODUCT_CREATED, {
        product: {
          id: p.id,
          slug: p.slug,
          name: p.name,
          description: p.description,
          shortDescription: p.shortDescription,
          status: p.status,
          type: p.type,
          seoTitle: p.seoTitle,
          seoDescription: p.seoDescription,
          media: p.media,
          metadata: p.metadata,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          variants: [
            {
              id: v.id,
              productId: p.id,
              sku: v.sku,
              name: v.name,
              priceMinor: v.priceMinor,
              compareAtPriceMinor: null,
              weightGrams: null,
              dimensions: null,
              stock: v.stock,
              lowStockThreshold: 3,
              options: v.options,
              status: 'active' as const,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            },
          ],
          categoryIds: [cat.id],
        },
      })
    }),
    makeEvent(EVT_CUSTOMER_CREATED, {
      customerId: demoCustomer.id,
      email: demoCustomer.email,
    }),
    makeEvent(EVT_CUSTOMER_CREATED, {
      customerId: adminCustomer.id,
      email: adminCustomer.email,
    }),
  ]
  // The seed's events are not in the log, so nothing retries them: a handler that fails on one (a welcome mail the
  // mail host refuses) is reported and the seed goes on; its rows are committed, and the rebuild below projects them.
  const failures: Array<{ eventId: string; eventType: string; failed: unknown }> = []
  for (const event of events as NymbalEvent<unknown>[]) {
    try {
      await eventBus.publish(event)
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'adapter.handler_failed') throw err
      failures.push({ eventId: event.id, eventType: event.type, failed: failedOf(err) })
    }
  }
  if (failures.length > 0) {
    logger.warn({ failures }, 'seed events whose handlers failed; they are not retried')
  }

  logger.info({ adminEmail }, 'Admin user seeded')
  if (!process.env['NYMBAL_ADMIN_EMAIL']) {
    console.log(
      `Admin seeded: ${adminEmail} / ${adminPassword} (change NYMBAL_ADMIN_PASSWORD to override)`,
    )
  }

  logger.info(
    {
      categories: categoryInserts.length,
      products: productInserts.length,
      variants: variantInserts.length,
      customers: 1,
      admins: 1,
    },
    'Seed complete',
  )

  const search = deps.search
  await rebuild(
    search === undefined ? READ_MODEL_NAMES.filter((name) => name !== 'search') : READ_MODEL_NAMES,
    {
      config,
      store: commandStore,
      repos: buildRepositories(commandStore, documentStore),
      documentStore,
      ...(search !== undefined && { search }),
      logger,
    },
  )

  return {
    categories: categoryInserts.length,
    products: productInserts.length,
    variants: variantInserts.length,
    customers: 1,
    admins: 1,
    alreadySeeded: false,
  }
}
