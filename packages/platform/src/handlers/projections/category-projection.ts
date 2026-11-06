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
import type { Repositories } from '../../repositories/index.js'
import { buildCategoryDoc, CATEGORIES } from '../../read-models/builders.js'
import { settle } from '../../read-models/settle.js'
import { subscribeDerived, type DerivedHandler } from '../derived.js'

export interface CategoryProjectionDeps {
  documentStore: DocumentStoreAdapter
  logger: Logger
  storeId: string
  repos: Pick<Repositories, 'category'>
}

export interface RegisterCategoryProjectionDeps extends CategoryProjectionDeps {
  eventBus: EventBusAdapter
}

/**
 * The `categories` documents, built from the category row read at handle time: a re-applied old delivery then writes
 * what a rebuild writes, not the payload it carried.
 */
export function categoryProjection(deps: CategoryProjectionDeps): DerivedHandler[] {
  const { documentStore, logger, storeId, repos } = deps

  const onUpsert: EventHandler<CategoryCreatedV1Payload | CategoryUpdatedV1Payload> = async (
    event,
  ) => {
    const { id, slug } = event.payload.category
    await settle(documentStore, `category ${id}`, async () => {
      const category = await repos.category.store.read((tx) => repos.category.findById(tx, id))
      if (!category) {
        // The slug may since have gone to another category, whose document stays.
        return {
          puts: [],
          deletes: async () => {
            const stored = await documentStore.get<{ id: string }>(CATEGORIES, slug)
            return stored?.id === id ? [{ collection: CATEGORIES, key: slug }] : []
          },
        }
      }
      const doc = buildCategoryDoc(category, storeId)
      return { puts: [{ collection: CATEGORIES, key: category.slug, doc }] }
    })
    logger.debug({ slug, eventType: event.type }, 'category projected')
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
