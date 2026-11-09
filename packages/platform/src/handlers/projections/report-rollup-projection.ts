import type { EventBusAdapter, EventHandler, Logger, Order } from '@nymbalhq/types'
import type { ReadTx } from '../../db/command-store.js'
import type { Repositories } from '../../repositories/index.js'
import { foldEvent, ROLLUP_EVENT_TYPES, type RollupLookup } from '../../reports/fold.js'

const NAME = 'report-rollups'

export interface RegisterReportRollupProjectionDeps {
  eventBus: EventBusAdapter
  repos: Pick<Repositories, 'order' | 'cart' | 'processedEvent' | 'reportRollup'>
  /** The zone the store's days and hours are bucketed in. */
  timeZone: string
  logger: Logger
}

/** The order or cart this event names, read once so the fold stays synchronous and pure. */
async function lookupFor(
  tx: ReadTx,
  repos: RegisterReportRollupProjectionDeps['repos'],
  event: Parameters<EventHandler>[0],
): Promise<RollupLookup> {
  const { orderId, cartId } = event.payload as { orderId?: string; cartId?: string }
  const order = orderId ? await repos.order.findById(tx, orderId) : null
  const cartSource = cartId ? (await repos.cart.findByToken(tx, cartId))?.source ?? null : null
  return {
    orderOf: (id): Order | null => (id === orderId ? order : null),
    cartSourceOf: (token) => (token === cartId ? cartSource : null),
  }
}

/** `report-rollups`: one delivery, one transaction. The claim and the counters commit or roll back together. */
export async function registerReportRollupProjection(
  deps: RegisterReportRollupProjectionDeps,
): Promise<void> {
  const { eventBus, repos, timeZone, logger } = deps
  const { store } = repos.processedEvent
  const handle: EventHandler = async (event) => {
    await store.transaction(async (tx) => {
      const claimed = await repos.processedEvent.claim(tx, NAME, event.id, new Date())
      if (!claimed) return
      const deltas = foldEvent(event, await lookupFor(tx, repos, event), timeZone)
      const at = new Date()
      for (const delta of deltas) await repos.reportRollup.apply(tx, delta, at)
    })
    logger.debug({ type: event.type }, 'report rollup applied')
  }
  await eventBus.subscribe([...ROLLUP_EVENT_TYPES], handle, { name: NAME })
}
