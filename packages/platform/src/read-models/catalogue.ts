import type { Category, ProductSnapshot } from '@nymbalhq/types'
import type { ReadTx } from '../db/command-store.js'
import type { KeysetPage } from '../repositories/index.js'
import { categoryProjection } from '../handlers/projections/category-projection.js'
import { inventoryProjection } from '../handlers/projections/inventory-projection.js'
import { productProjection } from '../handlers/projections/product-projection.js'
import {
  buildCategoryDoc,
  buildProductDoc,
  CATEGORIES,
  productWrites,
  PRODUCTS,
  PRODUCTS_BY_CATEGORY,
} from './builders.js'
import type { ReadModel, RebuildDeps } from './model.js'
import { productSnapshot } from './sources.js'

/** Every product of a page, with its variants and category ids. */
export function snapshotsOf({ repos }: RebuildDeps) {
  return async (tx: ReadTx, page: KeysetPage): Promise<ProductSnapshot[]> => {
    const out: ProductSnapshot[] = []
    for (const p of await repos.product.listPage(tx, page)) {
      out.push(await productSnapshot(tx, repos, p))
    }
    return out
  }
}

export const catalogue: ReadModel = {
  name: 'catalogue',
  target: 'documents',
  collections: [CATEGORIES, PRODUCTS, PRODUCTS_BY_CATEGORY],

  async *rebuild(ctx) {
    const { config, repos, logger } = ctx.deps
    const storeId = config.store.name
    const categories = new Map<string, Category>()
    for await (const page of ctx.pages('categories', (tx, p) => repos.category.listPage(tx, p))) {
      for (const c of page) {
        categories.set(c.id, c)
        yield { collection: CATEGORIES, key: c.slug, doc: buildCategoryDoc(c, storeId) }
      }
    }
    const context = { storeId, currency: config.store.currency, logger }
    for await (const page of ctx.pages('products', snapshotsOf(ctx.deps))) {
      for (const snapshot of page) {
        yield* productWrites(buildProductDoc(snapshot, categories, context))
      }
    }
  },

  handlers({ config, documentStore, logger, repos }) {
    const product = {
      documentStore,
      logger,
      storeId: config.store.name,
      currency: config.store.currency,
      repos,
    }
    return [
      ...categoryProjection({ documentStore, logger, storeId: config.store.name }),
      ...productProjection(product),
      ...inventoryProjection(product),
    ]
  },
}
