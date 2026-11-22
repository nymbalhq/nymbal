import {
  EVT_PRODUCT_VIEWED,
  EVT_VISITOR_MERGED,
  type Logger,
  type RecentViewer,
} from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { EventPublisher } from '../events/publisher.js'
import type { Repositories } from '../repositories/index.js'

export interface RecentlyViewedServiceDeps {
  store: CommandStore
  repos: Pick<Repositories, 'product'>
  publisher: EventPublisher
  logger: Logger
  /** The view's time, which its event carries. */
  now?: () => Date
}

export interface RecentlyViewedService {
  /** Logs a view of an active product; false, and nothing logged, for any other id. */
  record(viewer: RecentViewer, productId: string): Promise<boolean>
  /** Moves a visitor's views to the customer who signed in carrying its cookie. */
  fold(visitorId: string, customerId: string): Promise<void>
}

export function createRecentlyViewedService(
  deps: RecentlyViewedServiceDeps,
): RecentlyViewedService {
  const { store, repos, publisher, logger } = deps
  const clock = deps.now ?? (() => new Date())
  // Each stamp strictly after the last: the read model moves a visitor's views up to the merge's instant, so a view
  // sharing the merge's millisecond would move live but stay behind in a rebuild that folds in log order.
  let last = -Infinity
  const now = (): Date => {
    last = Math.max(clock().getTime(), last + 1)
    return new Date(last)
  }

  return {
    async record(viewer, productId) {
      const product = await store.read((tx) => repos.product.findById(tx, productId))
      if (product?.status !== 'active') return false
      await publisher.publish(EVT_PRODUCT_VIEWED, { productId, viewer }, { timestamp: now() })
      logger.debug({ productId, viewer: viewer.kind }, 'product view recorded')
      return true
    },

    async fold(visitorId, customerId) {
      await publisher.publish(
        EVT_VISITOR_MERGED,
        { visitorId, customerId },
        { timestamp: now() },
      )
      logger.debug({ customerId }, 'visitor views folded into the customer')
    },
  }
}
