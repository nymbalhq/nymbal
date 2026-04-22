import {
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_UPDATED,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type ProductCreatedV1Payload,
  type ProductDeletedV1Payload,
  type ProductUpdatedV1Payload,
  type SearchAdapter,
  type SearchDocument,
} from '@nymbal/types'
import { withIdempotency } from '../idempotency.js'
import type { ProcessedEventRepository } from '../../repositories/processed-event.js'

export interface RegisterSearchHandlerDeps {
  eventBus: EventBusAdapter
  search: SearchAdapter
  logger: Logger
  processedEventRepo: ProcessedEventRepository
}

export async function registerSearchHandler(deps: RegisterSearchHandlerDeps): Promise<void> {
  const { eventBus, search, logger, processedEventRepo } = deps

  const onUpsert: EventHandler<ProductCreatedV1Payload | ProductUpdatedV1Payload> = async (event) => {
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

  await eventBus.subscribe(
    [EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED],
    withIdempotency('search:product-upsert', onUpsert as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'search-product-upsert' },
  )
  await eventBus.subscribe(
    EVT_PRODUCT_DELETED,
    withIdempotency('search:product-delete', onDelete as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'search-product-delete' },
  )
}
