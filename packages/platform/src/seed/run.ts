import { v7 as uuidv7 } from 'uuid'
import type { DocumentStoreAdapter, EventBusAdapter, Logger } from '@nymbal/types'
import type { NymbalConfig } from '@nymbal/config'
import type { CommandStore } from '../db/command-store.js'
import { createCategoryRepository } from '../db/repositories/categories.js'
import { createProductRepository } from '../db/repositories/products.js'
import { createEventBuilder } from '../events/builder.js'
import { EVT_CATEGORY_CREATED, EVT_PRODUCT_CREATED } from '@nymbal/types'
import { seedCategories, seedProducts } from './data.js'

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
  const categoryInserts = seedCategories.map((c) => ({
    id: uuidv7(),
    slug: c.slug,
    name: c.name,
    description: c.description,
    createdAt: now,
  }))
  await categoryRepo.insertMany(categoryInserts)

  const categoryBySlug = new Map(categoryInserts.map((c) => [c.slug, c]))

  const productInserts = seedProducts.map((p) => {
    const category = categoryBySlug.get(p.categorySlug)
    if (!category) {
      throw new Error(`Seed data references unknown category: ${p.categorySlug}`)
    }
    return {
      id: uuidv7(),
      slug: p.slug,
      title: p.title,
      description: p.description,
      priceMinor: p.priceMinor,
      currency: config.store.currency,
      categoryId: category.id,
      imageUrl: p.imageUrl,
      createdAt: now,
      updatedAt: now,
    }
  })
  await productRepo.insertMany(productInserts)

  // Replicate to document store.
  const productDocs = new Map<string, Record<string, unknown>>()
  for (const p of productInserts) {
    productDocs.set(p.id, {
      id: p.id,
      storeId: config.store.name,
      slug: p.slug,
      title: p.title,
      description: p.description,
      priceMinor: p.priceMinor,
      currency: p.currency,
      categoryId: p.categoryId,
      categorySlug: seedProducts.find((sp) => sp.slug === p.slug)?.categorySlug,
      imageUrl: p.imageUrl,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
  }
  await documentStore.batchPut('products', productDocs)

  const categoryDocs = new Map<string, Record<string, unknown>>()
  for (const c of categoryInserts) {
    categoryDocs.set(c.id, {
      id: c.id,
      storeId: config.store.name,
      slug: c.slug,
      name: c.name,
      description: c.description,
      createdAt: now.toISOString(),
    })
  }
  await documentStore.batchPut('categories', categoryDocs)

  // Emit events.
  await eventBus.publishBatch([
    ...categoryInserts.map((c) => makeEvent(EVT_CATEGORY_CREATED, { id: c.id, slug: c.slug })),
    ...productInserts.map((p) => makeEvent(EVT_PRODUCT_CREATED, { id: p.id, slug: p.slug })),
  ])

  logger.info(
    { categories: categoryInserts.length, products: productInserts.length },
    'Seed complete',
  )
  return { categories: categoryInserts.length, products: productInserts.length }
}
