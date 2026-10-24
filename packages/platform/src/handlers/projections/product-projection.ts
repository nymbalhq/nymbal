import {
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_DELETED,
  EVT_CATEGORY_UPDATED,
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_UPDATED,
  type CategoryCreatedV1Payload,
  type CategoryDeletedV1Payload,
  type CategoryUpdatedV1Payload,
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type ProductCreatedV1Payload,
  type ProductDeletedV1Payload,
  type ProductUpdatedV1Payload,
} from '@nymbalhq/types'
import type { Repositories } from '../../repositories/index.js'
import {
  buildProductDoc,
  productByCategoryKey,
  productWrites,
  PRODUCTS,
  PRODUCTS_BY_CATEGORY,
  type DenormalisedProduct,
} from '../../read-models/builders.js'
import { loadProduct } from '../../read-models/sources.js'
import { subscribeDerived, type DerivedHandler } from '../derived.js'

export type { DenormalisedProduct } from '../../read-models/builders.js'

export interface ProductProjectionDeps {
  documentStore: DocumentStoreAdapter
  logger: Logger
  storeId: string
  currency: string
  repos: Pick<Repositories, 'product' | 'variant' | 'category' | 'productCategory'>
}

export interface RegisterProductProjectionDeps extends ProductProjectionDeps {
  eventBus: EventBusAdapter
}

export interface ProductReprojector {
  /** Rebuilds the product's documents from its rows as they are now; a product that is gone is left to its delete. */
  reproject(productId: string): Promise<void>
  /** Removes the product's documents, by slug. */
  remove(slug: string): Promise<void>
}

/**
 * Writes `products` and `products-by-category` from the product's rows, read at handle time, so any event about a
 * product, its stock or one of its categories leaves the documents a rebuild writes.
 */
export function productReprojector(deps: ProductProjectionDeps): ProductReprojector {
  const { documentStore, logger, storeId, currency, repos } = deps

  /** The category keys the stored document was filed under. */
  async function filedUnder(slug: string): Promise<string[]> {
    const existing = await documentStore.get<DenormalisedProduct>(PRODUCTS, slug)
    return (existing?.categories ?? []).map((c) => productByCategoryKey(c.slug, slug))
  }

  return {
    async reproject(productId) {
      const loaded = await repos.product.store.read((tx) => loadProduct(tx, repos, productId))
      if (!loaded) return
      const doc = buildProductDoc(loaded.snapshot, loaded.categories, { storeId, currency, logger })
      const writes = productWrites(doc)
      const kept = new Set(writes.map((w) => w.key))
      const stale = (await filedUnder(doc.slug)).filter((key) => !kept.has(key))
      for (const w of writes) await documentStore.put(w.collection, w.key, w.doc)
      for (const key of stale) await documentStore.delete(PRODUCTS_BY_CATEGORY, key)
      logger.debug({ slug: doc.slug }, 'product projected')
    },
    async remove(slug) {
      for (const key of await filedUnder(slug)) {
        await documentStore.delete(PRODUCTS_BY_CATEGORY, key)
      }
      await documentStore.delete(PRODUCTS, slug)
      logger.debug({ slug }, 'product projection deleted')
    },
  }
}

export function productProjection(deps: ProductProjectionDeps): DerivedHandler[] {
  const products = productReprojector(deps)
  const { repos } = deps

  const onUpsert: EventHandler<ProductCreatedV1Payload | ProductUpdatedV1Payload> = (event) =>
    products.reproject(event.payload.product.id)

  const onDelete: EventHandler<ProductDeletedV1Payload> = (event) =>
    products.remove(event.payload.slug)

  // A category's name and slug are in its products' documents, and its slug in their category keys.
  const onCategory: EventHandler<
    CategoryCreatedV1Payload | CategoryUpdatedV1Payload | CategoryDeletedV1Payload
  > = async (event) => {
    const payload = event.payload
    const categoryId = 'category' in payload ? payload.category.id : payload.categoryId
    const productIds = await repos.productCategory.store.read((tx) =>
      repos.productCategory.listProductsForCategory(tx, categoryId),
    )
    for (const productId of productIds) await products.reproject(productId)
  }

  return [
    {
      name: 'product-projection-upsert',
      types: [EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED],
      handle: onUpsert as EventHandler,
    },
    {
      name: 'product-projection-delete',
      types: [EVT_PRODUCT_DELETED],
      handle: onDelete as EventHandler,
    },
    {
      name: 'product-projection-category',
      types: [EVT_CATEGORY_CREATED, EVT_CATEGORY_UPDATED, EVT_CATEGORY_DELETED],
      handle: onCategory as EventHandler,
    },
  ]
}

export async function registerProductProjection(
  deps: RegisterProductProjectionDeps,
): Promise<void> {
  await subscribeDerived(deps.eventBus, productProjection(deps))
}
