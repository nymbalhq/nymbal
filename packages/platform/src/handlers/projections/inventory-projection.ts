import {
  EVT_INVENTORY_CHANGED,
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type EventHandler,
  type InventoryChangedV1Payload,
  type Logger,
} from '@nymbal/types'
import type { VariantRepository } from '../../repositories/variant.js'
import type { ProductRepository } from '../../repositories/product.js'
import type { ProductCategoryRepository } from '../../repositories/product-category.js'
import type { DenormalisedProduct } from './product-projection.js'

const PRODUCTS = 'products'

export interface RegisterInventoryProjectionDeps {
  eventBus: EventBusAdapter
  documentStore: DocumentStoreAdapter
  logger: Logger
  variantRepo: VariantRepository
  productRepo: ProductRepository
  productCategoryRepo: ProductCategoryRepository
}

export async function registerInventoryProjection(
  deps: RegisterInventoryProjectionDeps,
): Promise<void> {
  const { eventBus, documentStore, logger, variantRepo, productRepo } = deps

  const handler: EventHandler<InventoryChangedV1Payload> = async (event) => {
    const { variantId, newQty } = event.payload
    const variant = await variantRepo.findById(variantId)
    if (!variant) return
    const product = await productRepo.findById(variant.productId)
    if (!product) return
    const doc = await documentStore.get<DenormalisedProduct>(PRODUCTS, product.slug)
    if (!doc) return
    const variants = doc.variants.map((v) =>
      v.id === variantId ? { ...v, stock: newQty } : v,
    )
    const inStock = variants.some((v) => v.stock > 0)
    await documentStore.put<DenormalisedProduct>(PRODUCTS, product.slug, {
      ...doc,
      variants,
      inStock,
    })
    logger.debug({ variantId, newQty, slug: product.slug }, 'inventory projection updated')
  }

  await eventBus.subscribe(EVT_INVENTORY_CHANGED, handler as EventHandler, {
    name: 'inventory-projection',
  })
}
