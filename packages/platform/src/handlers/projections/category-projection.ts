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
} from '@nymbal/types'

const CATEGORIES = 'categories'

export interface RegisterCategoryProjectionDeps {
  eventBus: EventBusAdapter
  documentStore: DocumentStoreAdapter
  logger: Logger
  storeId: string
}

export async function registerCategoryProjection(
  deps: RegisterCategoryProjectionDeps,
): Promise<void> {
  const { eventBus, documentStore, logger, storeId } = deps

  const onUpsert: EventHandler<CategoryCreatedV1Payload | CategoryUpdatedV1Payload> = async (
    event,
  ) => {
    const { category } = event.payload
    await documentStore.put(CATEGORIES, category.slug, {
      id: category.id,
      storeId,
      parentId: category.parentId,
      slug: category.slug,
      name: category.name,
      description: category.description,
      position: category.position,
      createdAt: category.createdAt,
    })
    logger.debug({ slug: category.slug, eventType: event.type }, 'category projected')
  }

  const onDeleted: EventHandler<CategoryDeletedV1Payload> = async (event) => {
    await documentStore.delete(CATEGORIES, event.payload.slug)
    logger.debug({ slug: event.payload.slug }, 'category projection deleted')
  }

  await eventBus.subscribe(
    [EVT_CATEGORY_CREATED, EVT_CATEGORY_UPDATED],
    onUpsert as EventHandler,
    { name: 'category-projection-upsert' },
  )
  await eventBus.subscribe(EVT_CATEGORY_DELETED, onDeleted as EventHandler, {
    name: 'category-projection-delete',
  })
}
