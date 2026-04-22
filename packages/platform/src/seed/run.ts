import { v7 as uuidv7 } from 'uuid'
import bcrypt from 'bcryptjs'
const { hashSync } = bcrypt
import type { DocumentStoreAdapter, EventBusAdapter, Logger } from '@nymbal/types'
import type { NymbalConfig } from '@nymbal/config'
import type { CommandStore } from '../db/command-store.js'
import { createCategoryRepository } from '../db/repositories/categories.js'
import { createProductRepository } from '../db/repositories/products.js'
import { createEventBuilder } from '../events/builder.js'
import {
  EVT_CATEGORY_CREATED,
  EVT_PRODUCT_CREATED,
  EVT_CUSTOMER_CREATED,
} from '@nymbal/types'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { seedCategories, seedProducts, type SeedProduct } from './data.js'

export interface SeedDeps {
  config: NymbalConfig
  commandStore: CommandStore
  documentStore: DocumentStoreAdapter
  eventBus: EventBusAdapter
  logger: Logger
  version: string
}

export interface SeedResult {
  categories: number
  products: number
  variants: number
  customers: number
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
  if (store.kind === 'sqlite') {
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
    store.db.insert(sqliteSchema.variants).values(values).run()
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
  await store.db.insert(postgresSchema.variants).values(values)
}

async function insertProductCategories(
  store: CommandStore,
  rows: Array<{ productId: string; categoryId: string }>,
): Promise<void> {
  if (rows.length === 0) return
  if (store.kind === 'sqlite') {
    store.db.insert(sqliteSchema.productCategories).values(rows).run()
    return
  }
  await store.db.insert(postgresSchema.productCategories).values(rows)
}

async function insertCustomer(
  store: CommandStore,
  row: {
    id: string
    email: string
    passwordHash: string
    firstName: string
    lastName: string
    createdAt: Date
    updatedAt: Date
  },
): Promise<void> {
  if (store.kind === 'sqlite') {
    store.db
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
        requiresPasswordReset: false,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })
      .run()
    return
  }
  await store.db.insert(postgresSchema.customers).values({
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
    requiresPasswordReset: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
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
    media: [{ url: p.imageUrl, altText: p.title, position: 0 }],
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
    email: 'demo@nymbal.dev',
    passwordHash: hashSync('nymbal', 10),
    firstName: 'Demo',
    lastName: 'User',
    createdAt: now,
    updatedAt: now,
  }
  await insertCustomer(commandStore, demoCustomer)

  // Document-store read-model rebuild
  const productDocs = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < productInserts.length; i++) {
    const p = productInserts[i]!
    const v = variantInserts[i]!
    const seed = seedProducts[i] as SeedProduct
    const catSlug = seed.categorySlug
    productDocs.set(p.slug, {
      id: p.id,
      storeId: config.store.name,
      slug: p.slug,
      name: p.name,
      description: p.description,
      shortDescription: p.shortDescription,
      status: p.status,
      type: p.type,
      media: p.media,
      priceMinor: v.priceMinor,
      currency: config.store.currency,
      categorySlugs: [catSlug],
      variants: [
        {
          id: v.id,
          sku: v.sku,
          name: v.name,
          priceMinor: v.priceMinor,
          stock: v.stock,
          options: v.options,
        },
      ],
      variantCount: 1,
      inStock: true,
      priceRange: { minMinor: v.priceMinor, maxMinor: v.priceMinor },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
  }
  await documentStore.batchPut('products', productDocs)

  // Secondary index: products-by-category
  const byCategory = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < productInserts.length; i++) {
    const p = productInserts[i]!
    const seed = seedProducts[i] as SeedProduct
    const doc = productDocs.get(p.slug)!
    byCategory.set(`category:${seed.categorySlug}#product:${p.slug}`, {
      partitionKey: `category:${seed.categorySlug}`,
      sortKey: `product:${p.slug}`,
      ...doc,
    })
  }
  await documentStore.batchPut('products-by-category', byCategory)

  // Category docs
  const categoryDocs = new Map<string, Record<string, unknown>>()
  for (const c of categoryInserts) {
    categoryDocs.set(c.slug, {
      id: c.id,
      storeId: config.store.name,
      slug: c.slug,
      name: c.name,
      description: c.description,
      position: c.position,
      createdAt: now.toISOString(),
    })
  }
  await documentStore.batchPut('categories', categoryDocs)

  // Customer profile (no PII)
  await documentStore.put('customer-profiles', demoCustomer.id, {
    customerId: demoCustomer.id,
    orderCount: 0,
    totalSpentMinor: 0,
    segment: 'new',
    createdAt: now.toISOString(),
  })

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
  ]
  await eventBus.publishBatch(events)

  logger.info(
    {
      categories: categoryInserts.length,
      products: productInserts.length,
      variants: variantInserts.length,
      customers: 1,
    },
    'Seed complete',
  )
  return {
    categories: categoryInserts.length,
    products: productInserts.length,
    variants: variantInserts.length,
    customers: 1,
  }
}
