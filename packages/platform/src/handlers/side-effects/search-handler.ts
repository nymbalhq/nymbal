import {
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_UPDATED,
  type EventBusAdapter,
  type EventHandler,
  type ProductCreatedV1Payload,
  type ProductDeletedV1Payload,
  type ProductUpdatedV1Payload,
  type SearchAdapter,
  type SearchDocument,
} from '@nymbalhq/types'

export interface RegisterSearchHandlerDeps {
  eventBus: EventBusAdapter
  search: SearchAdapter
}

export async function registerSearchHandler(deps: RegisterSearchHandlerDeps): Promise<void> {
  const { eventBus, search } = deps

  const onUpsert: EventHandler<ProductCreatedV1Payload | ProductUpdatedV1Payload> = async (
    event,
  ) => {
    const p = event.payload.product
    const doc: SearchDocument = {
      id: p.id,
      type: 'product',
      fields: {
        slug: p.slug,
        name: p.name,
        description: p.description,
        status: p.status,
        categoryIds: p.categoryIds,
        variants: p.variants.map((v) => ({ sku: v.sku, name: v.name, priceMinor: v.priceMinor })),
      },
    }
    await search.index([doc])
  }

  const onDelete: EventHandler<ProductDeletedV1Payload> = async (event) => {
    await search.remove([event.payload.productId])
  }

  // Derived state: indexing and removing by document id is idempotent, so no processed-event record is kept, and
  // warm-up's replay rebuilds the index.
  await eventBus.subscribe([EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED], onUpsert as EventHandler, {
    name: 'search-product-upsert',
    derived: true,
  })
  await eventBus.subscribe(EVT_PRODUCT_DELETED, onDelete as EventHandler, {
    name: 'search-product-delete',
    derived: true,
  })
}
