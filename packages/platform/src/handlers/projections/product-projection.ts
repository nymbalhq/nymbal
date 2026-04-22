import {
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_UPDATED,
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type NymbalEvent,
  type ProductDeletedV1Payload,
  type ProductSnapshot,
  type ProductCreatedV1Payload,
  type ProductUpdatedV1Payload,
} from '@nymbal/types'

const PRODUCTS = 'products'
const PRODUCTS_BY_CATEGORY = 'products-by-category'

export interface DenormalisedProduct {
  id: string
  storeId: string
  slug: string
  name: string
  description: string
  shortDescription: string
  status: string
  type: string
  media: unknown
  variantCount: number
  inStock: boolean
  priceRange: { minMinor: number; maxMinor: number } | null
  currency: string | null
  priceMinor: number | null
  variants: Array<{
    id: string
    sku: string
    name: string
    priceMinor: number
    stock: number
    options: unknown
  }>
  categoryIds: string[]
  createdAt: string
  updatedAt: string
  partitionKey?: string
  sortKey?: string
}

function denormalise(p: ProductSnapshot, storeId: string, storeCurrency: string): DenormalisedProduct {
  const prices = p.variants.map((v) => v.priceMinor)
  const priceRange = prices.length
    ? { minMinor: Math.min(...prices), maxMinor: Math.max(...prices) }
    : null
  const inStock = p.variants.some((v) => v.stock > 0)
  return {
    id: p.id,
    storeId,
    slug: p.slug,
    name: p.name,
    description: p.description,
    shortDescription: p.shortDescription,
    status: p.status,
    type: p.type,
    media: p.media,
    variantCount: p.variants.length,
    inStock,
    priceRange,
    currency: storeCurrency,
    priceMinor: prices[0] ?? null,
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      priceMinor: v.priceMinor,
      stock: v.stock,
      options: v.options,
    })),
    categoryIds: p.categoryIds,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

export interface RegisterProductProjectionDeps {
  eventBus: EventBusAdapter
  documentStore: DocumentStoreAdapter
  logger: Logger
  storeId: string
  currency: string
}

export async function registerProductProjection(deps: RegisterProductProjectionDeps): Promise<void> {
  const { eventBus, documentStore, logger, storeId, currency } = deps

  const onUpsert: EventHandler<ProductCreatedV1Payload | ProductUpdatedV1Payload> = async (event) => {
    const { product } = event.payload
    const doc = denormalise(product, storeId, currency)
    await documentStore.put<DenormalisedProduct>(PRODUCTS, product.slug, doc)
    for (const categoryId of product.categoryIds) {
      await documentStore.put(
        PRODUCTS_BY_CATEGORY,
        `category:${categoryId}#product:${product.slug}`,
        { ...doc, partitionKey: `category:${categoryId}`, sortKey: `product:${product.slug}` },
      )
    }
    logger.debug({ slug: product.slug, eventType: event.type }, 'product projected')
  }

  const onDelete: EventHandler<ProductDeletedV1Payload> = async (event: NymbalEvent<ProductDeletedV1Payload>) => {
    const { productId, slug } = event.payload
    const existing = await documentStore.get<DenormalisedProduct>(PRODUCTS, slug)
    if (existing) {
      for (const categoryId of existing.categoryIds) {
        await documentStore.delete(PRODUCTS_BY_CATEGORY, `category:${categoryId}#product:${slug}`)
      }
    }
    await documentStore.delete(PRODUCTS, slug)
    logger.debug({ productId, slug }, 'product projection deleted')
  }

  await eventBus.subscribe(
    [EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED],
    onUpsert as EventHandler,
    { name: 'product-projection-upsert' },
  )
  await eventBus.subscribe(EVT_PRODUCT_DELETED, onDelete as EventHandler, {
    name: 'product-projection-delete',
  })
}
