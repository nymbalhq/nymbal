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
} from '@nymbalhq/types'
import type { Repositories } from '../../repositories/index.js'
import { buildSearchDoc } from '../../read-models/builders.js'
import { productSnapshot } from '../../read-models/sources.js'
import { subscribeDerived, type DerivedHandler } from '../derived.js'

export interface SearchHandlerDeps {
  search: SearchAdapter
  logger: Logger
  repos: Pick<Repositories, 'product' | 'variant' | 'category' | 'productCategory'>
}

export interface RegisterSearchHandlerDeps extends SearchHandlerDeps {
  eventBus: EventBusAdapter
}

/**
 * The search index, from the product's rows at handle time. Derived state: indexing and removing by id is idempotent,
 * so no processed-event record is kept, and a rebuild refills it.
 */
export function searchHandler(deps: SearchHandlerDeps): DerivedHandler[] {
  const { search, repos, logger } = deps

  // A slot that cannot index (a provider whose key is not set yet) is skipped: failing would kill every product
  // event, and `nymbal replay --to search` fills the index once it can.
  const skips = (event: { id: string; type: string }): boolean => {
    if (search.capabilities().includes('index')) return false
    logger.debug(
      { eventId: event.id, type: event.type, provider: search.providerName },
      'search: the slot cannot index, event skipped',
    )
    return true
  }

  const onUpsert: EventHandler<ProductCreatedV1Payload | ProductUpdatedV1Payload> = async (
    event,
  ) => {
    if (skips(event)) return
    const { id } = event.payload.product
    const snapshot = await repos.product.store.read(async (tx) => {
      const product = await repos.product.findById(tx, id)
      return product ? productSnapshot(tx, repos, product) : null
    })
    if (snapshot) await search.index([buildSearchDoc(snapshot)])
    else await search.remove([id])
  }

  const onDelete: EventHandler<ProductDeletedV1Payload> = async (event) => {
    if (skips(event)) return
    await search.remove([event.payload.productId])
  }

  return [
    {
      name: 'search-product-upsert',
      types: [EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED],
      handle: onUpsert as EventHandler,
    },
    {
      name: 'search-product-delete',
      types: [EVT_PRODUCT_DELETED],
      handle: onDelete as EventHandler,
    },
  ]
}

export async function registerSearchHandler(deps: RegisterSearchHandlerDeps): Promise<void> {
  await subscribeDerived(deps.eventBus, searchHandler(deps))
}
