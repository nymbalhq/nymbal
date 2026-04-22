import { v7 as uuidv7 } from 'uuid'
import {
  EVT_ORDER_DELIVERED,
  type AggregateRating,
  type Logger,
  type ReviewsAdapter,
  type ReviewsResult,
  type ReviewResult,
  type ReviewSubmission,
  type Review,
} from '@nymbal/types'
import type { Repositories } from '../../repositories/index.js'
import { noopInitialize, okHealth } from '../base.js'

export function createNativeReviewsAdapter(deps: {
  repos: Repositories
  logger: Logger
}): ReviewsAdapter {
  const { repos, logger } = deps
  return {
    kind: 'reviews',
    providerName: 'native',
    capabilities: ['submit', 'moderate', 'aggregate'],
    producesEvents: [],
    consumesEvents: [EVT_ORDER_DELIVERED],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),

    async getProductReviews(productId, params) {
      const limit = params?.limit ?? 20
      const items = await repos.review.listByProduct(productId, params?.status ?? 'approved', limit)
      return { items, nextCursor: null } satisfies ReviewsResult
    },

    async getAggregateRating(productId): Promise<AggregateRating> {
      const agg = await repos.review.aggregateByProduct(productId)
      return { productId, ...agg }
    },

    async submitReview(submission: ReviewSubmission): Promise<ReviewResult> {
      const id = uuidv7()
      const now = new Date()
      await repos.review.insert({
        id,
        productId: submission.productId,
        customerId: submission.customerId,
        orderId: submission.orderId,
        rating: submission.rating,
        title: submission.title,
        body: submission.body,
        moderationStatus: 'pending',
        submittedAt: now,
      })
      const review = (await repos.review.findById(id)) as Review
      logger.debug({ id, productId: submission.productId }, 'review submitted — pending moderation')
      return { review }
    },

    async requestReview(orderId) {
      logger.info({ orderId }, 'review requested (stub: no-op email)')
    },
  }
}
