import {
  EVT_ORDER_CANCELLED,
  EVT_ORDER_PAID,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type OrderCancelledV1Payload,
  type OrderPaidV1Payload,
  type PromotionsAdapter,
} from '@nymbalhq/types'
import { isNotConfigured } from '../../adapters/not-configured.js'
import type { Repositories } from '../../repositories/index.js'
import type { ProcessedEventRepository } from '../../repositories/processed-event.js'
import { withIdempotency } from '../idempotency.js'

export interface RegisterPromotionsHandlerDeps {
  eventBus: EventBusAdapter
  promotions: PromotionsAdapter
  processedEventRepo: ProcessedEventRepository
  repos: Pick<Repositories, 'order'>
  logger: Logger
}

/**
 * Tells the promotions engine a paid order is closed and a cancelled order cancelled, so it counts a code's use and
 * gives it back. Subscribed only for an engine that has the method; the not-configured placeholder answers every
 * property with a refusing function, so it is told apart by its mark. Only an order whose promotion record names this
 * engine is reported. A rejection is thrown, so the relay tries the event again; the engine's idempotency makes a
 * repeat harmless.
 */
export async function registerPromotionsHandler(
  deps: RegisterPromotionsHandlerDeps,
): Promise<void> {
  const { eventBus, promotions, processedEventRepo, repos, logger } = deps
  if (isNotConfigured(promotions)) return

  /** The record the order keeps of its promotions, when this engine placed it. */
  const placed = async (orderId: string) => {
    const order = await repos.order.store.read((tx) => repos.order.findById(tx, orderId))
    if (order === null) return undefined
    const record = order.metadata['promotions'] as
      | { provider?: unknown; sessionId?: unknown }
      | undefined
    if (record?.provider !== promotions.providerName || typeof record.sessionId !== 'string') {
      return undefined
    }
    return { order, sessionId: record.sessionId }
  }

  const close = promotions.close?.bind(promotions)
  if (typeof close === 'function') {
    const onPaid: EventHandler<OrderPaidV1Payload> = async (event) => {
      const found = await placed(event.payload.orderId)
      if (found === undefined) return
      const { order, sessionId } = found
      await close(sessionId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        currency: order.currency,
        subtotalMinor: order.subtotalMinor,
        discountTotalMinor: order.discountTotalMinor,
        totalMinor: order.totalMinor,
      })
      logger.info({ eventId: event.id, orderId: order.id }, 'the promotions session is closed')
    }
    await eventBus.subscribe(
      EVT_ORDER_PAID,
      withIdempotency('promotions.close', onPaid as EventHandler, {
        repo: processedEventRepo,
        logger,
      }),
      { name: 'promotions.close' },
    )
  }

  const cancel = promotions.cancel?.bind(promotions)
  if (typeof cancel === 'function') {
    const onCancelled: EventHandler<OrderCancelledV1Payload> = async (event) => {
      const found = await placed(event.payload.orderId)
      if (found === undefined) return
      await cancel(found.sessionId, found.order.id)
      logger.info(
        { eventId: event.id, orderId: found.order.id },
        'the promotions session is cancelled',
      )
    }
    await eventBus.subscribe(
      EVT_ORDER_CANCELLED,
      withIdempotency('promotions.cancel', onCancelled as EventHandler, {
        repo: processedEventRepo,
        logger,
      }),
      { name: 'promotions.cancel' },
    )
  }
}
