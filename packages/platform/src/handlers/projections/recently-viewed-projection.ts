import type { DocumentStoreAdapter, EventBusAdapter, EventHandler, Logger } from '@nymbalhq/types'
import {
  foldEvent,
  RECENTLY_VIEWED,
  RECENTLY_VIEWED_TYPES,
  type RecentlyViewedDoc,
  type ViewerDocuments,
} from '../../read-models/recently-viewed.js'
import { subscribeDerived, type DerivedHandler } from '../derived.js'

export interface RecentlyViewedProjectionDeps {
  documentStore: DocumentStoreAdapter
  logger: Logger
}

export interface RegisterRecentlyViewedProjectionDeps extends RecentlyViewedProjectionDeps {
  eventBus: EventBusAdapter
}

/** `recently-viewed`, one document per viewer, folded from views, sign-in merges and customer deletions. */
export function recentlyViewedProjection(deps: RecentlyViewedProjectionDeps): DerivedHandler[] {
  const { documentStore, logger } = deps
  const docs: ViewerDocuments = {
    get: (key) => documentStore.get<RecentlyViewedDoc>(RECENTLY_VIEWED, key),
    put: (key, doc) => documentStore.put(RECENTLY_VIEWED, key, doc),
    delete: (key) => documentStore.delete(RECENTLY_VIEWED, key),
  }
  const handle: EventHandler = async (event) => {
    await foldEvent(docs, event)
    logger.debug({ type: event.type }, 'recently viewed projected')
  }
  return [{ name: 'recently-viewed-projection', types: RECENTLY_VIEWED_TYPES, handle }]
}

export async function registerRecentlyViewedProjection(
  deps: RegisterRecentlyViewedProjectionDeps,
): Promise<void> {
  await subscribeDerived(deps.eventBus, recentlyViewedProjection(deps))
}
