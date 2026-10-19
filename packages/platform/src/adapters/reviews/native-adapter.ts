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
} from '@nymbalhq/types'
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
      const items = await repos.review.store.read((tx) =>
        repos.review.listByProduct(tx, productId, params?.status ?? 'approved', limit),
      )
      return { items, nextCursor: null } satisfies ReviewsResult
    },

    async getAggregateRating(productId): Promise<AggregateRating> {
      const agg = await repos.review.store.read((tx) =>
        repos.review.aggregateByProduct(tx, productId),
      )
      return { productId, ...agg }
    },

    async submitReview(submission: ReviewSubmission): Promise<ReviewResult> {
      const id = uuidv7()
      const now = new Date()
      const review = await repos.review.store.transaction(async (tx) => {
        await repos.review.insert(tx, {
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
        return (await repos.review.findById(tx, id)) as Review
      })
      logger.debug({ id, productId: submission.productId }, 'review submitted — pending moderation')
      return { review }
    },

    async requestReview(orderId) {
      logger.info({ orderId }, 'review requested (stub: no-op email)')
    },
  }
}
