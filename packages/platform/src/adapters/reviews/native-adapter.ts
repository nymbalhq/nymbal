import { v7 as uuidv7 } from 'uuid'
import {
  EVT_ORDER_DELIVERED,
  ValidationError,
  type AggregateRating,
  type Logger,
  type ReviewsAdapter,
  type ReviewsResult,
  type ReviewResult,
  type ReviewSubmission,
  type Review,
} from '@nymbalhq/types'
import type { Repositories } from '../../repositories/index.js'
import type { ReviewKey } from '../../repositories/review.js'
import { noopInitialize, okHealth } from '../base.js'

function encodeReviewCursor(review: Review): string {
  return Buffer.from(JSON.stringify([review.submittedAt, review.id]), 'utf8').toString('base64url')
}

function decodeReviewCursor(cursor: string): ReviewKey {
  let key: unknown
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch (err) {
    throw new ValidationError('malformed reviews cursor', { cause: err })
  }
  if (
    !Array.isArray(key) ||
    key.length !== 2 ||
    typeof key[0] !== 'string' ||
    typeof key[1] !== 'string' ||
    Number.isNaN(Date.parse(key[0])) ||
    Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') !== cursor
  ) {
    throw new ValidationError('malformed reviews cursor')
  }
  return { submittedAt: key[0], id: key[1] }
}

export function createNativeReviewsAdapter(deps: {
  repos: Repositories
  logger: Logger
}): ReviewsAdapter {
  const { repos, logger } = deps
  return {
    kind: 'reviews',
    providerName: 'native',
    capabilities: () => ['submit', 'moderate', 'aggregate'],
    producesEvents: [],
    consumesEvents: [EVT_ORDER_DELIVERED],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),

    async getProductReviews(productId, params) {
      const limit = params?.limit ?? 20
      const after = params?.cursor === undefined ? undefined : decodeReviewCursor(params.cursor)
      // One past the page says whether another follows, so the last page has no cursor.
      const rows = await repos.review.store.read((tx) =>
        repos.review.listByProduct(tx, productId, params?.status ?? 'approved', limit + 1, after),
      )
      const items = rows.slice(0, limit)
      const last = items[items.length - 1]
      const nextCursor = rows.length > limit && last !== undefined ? encodeReviewCursor(last) : null
      return { items, nextCursor } satisfies ReviewsResult
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
