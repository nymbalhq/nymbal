import {
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_DELETED,
  EVT_CATEGORY_UPDATED,
  type CategoryCreatedV1Payload,
  type CategoryDeletedV1Payload,
  type CategoryUpdatedV1Payload,
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
} from '@nymbalhq/types'
import { buildCategoryDoc, CATEGORIES } from '../../read-models/builders.js'
import { subscribeDerived, type DerivedHandler } from '../derived.js'

export interface CategoryProjectionDeps {
  documentStore: DocumentStoreAdapter
  logger: Logger
  storeId: string
}

export interface RegisterCategoryProjectionDeps extends CategoryProjectionDeps {
  eventBus: EventBusAdapter
}

/** The `categories` documents. The payloads carry the category row as committed, which is the builder's input. */
export function categoryProjection(deps: CategoryProjectionDeps): DerivedHandler[] {
  const { documentStore, logger, storeId } = deps

  const onUpsert: EventHandler<CategoryCreatedV1Payload | CategoryUpdatedV1Payload> = async (
    event,
  ) => {
    const { category } = event.payload
    await documentStore.put(CATEGORIES, category.slug, buildCategoryDoc(category, storeId))
    logger.debug({ slug: category.slug, eventType: event.type }, 'category projected')
  }

  const onDeleted: EventHandler<CategoryDeletedV1Payload> = async (event) => {
    await documentStore.delete(CATEGORIES, event.payload.slug)
    logger.debug({ slug: event.payload.slug }, 'category projection deleted')
  }

  return [
    {
      name: 'category-projection-upsert',
      types: [EVT_CATEGORY_CREATED, EVT_CATEGORY_UPDATED],
      handle: onUpsert as EventHandler,
    },
    {
      name: 'category-projection-delete',
      types: [EVT_CATEGORY_DELETED],
      handle: onDeleted as EventHandler,
    },
  ]
}

export async function registerCategoryProjection(
  deps: RegisterCategoryProjectionDeps,
): Promise<void> {
  await subscribeDerived(deps.eventBus, categoryProjection(deps))
}
