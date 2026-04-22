import {
  EVT_ORDER_DELIVERED,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type OrderDeliveredV1Payload,
  type ReviewsAdapter,
} from '@nymbal/types'
import { withIdempotency } from '../idempotency.js'
import type { ProcessedEventRepository } from '../../repositories/processed-event.js'

export interface RegisterReviewsHandlerDeps {
  eventBus: EventBusAdapter
  reviews: ReviewsAdapter
  logger: Logger
  processedEventRepo: ProcessedEventRepository
}

export async function registerReviewsHandler(deps: RegisterReviewsHandlerDeps): Promise<void> {
  const { eventBus, reviews, logger, processedEventRepo } = deps

  const handler: EventHandler<OrderDeliveredV1Payload> = async (event) => {
    await reviews.requestReview(event.payload.orderId)
  }

  await eventBus.subscribe(
    EVT_ORDER_DELIVERED,
    withIdempotency('reviews:order-delivered', handler as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'reviews-order-delivered' },
  )
}
