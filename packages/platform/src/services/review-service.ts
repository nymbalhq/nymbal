import {
  EVT_REVIEW_SUBMITTED,
  NotFoundError,
  ReviewRefusedError,
  type Logger,
  type OrderStatus,
  type Review,
  type ReviewsAdapter,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { CommandStore } from '../db/command-store.js'
import type { EventPublisher } from '../events/publisher.js'
import type { Repositories } from '../repositories/index.js'

/** The order statuses that make a review verified: the order was paid and not cancelled. A wholly refunded one is out by its money. */
export const REVIEW_VERIFYING_STATUSES: readonly OrderStatus[] = [
  'confirmed',
  'processing',
  'shipped',
  'delivered',
]

export interface ReviewSubmitInput {
  customerId: string
  productId: string
  rating: number
  title: string
  body: string
}

export interface ReviewService {
  /**
   * Files the signed-in customer's review of an active product through the reviews adapter, as theirs and verified
   * by their newest paid order holding the product, and publishes `review.submitted.v1` for what the adapter stored.
   */
  submit(input: ReviewSubmitInput): Promise<Review>
}

export interface ReviewServiceDeps {
  store: CommandStore
  repos: Pick<Repositories, 'product' | 'customer' | 'order'>
  publisher: EventPublisher
  reviews: ReviewsAdapter
  logger: Logger
}

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const { store, repos, publisher, reviews, logger } = deps

  return {
    async submit(input) {
      const { customerId, productId } = input
      audit.note('review.submit', [{ type: 'product', id: productId }])
      const product = await store.read((tx) => repos.product.findById(tx, productId))
      if (product?.status !== 'active') throw new NotFoundError('product', productId)
      if (!reviews.capabilities().includes('submit')) {
        throw new ReviewRefusedError('submit_unsupported')
      }
      const { customer, order } = await store.read(async (tx) => ({
        customer: await repos.customer.findById(tx, customerId),
        order: await repos.order.newestHolding(tx, customerId, productId, REVIEW_VERIFYING_STATUSES),
      }))
      if (customer === null) throw new NotFoundError('customer', customerId)

      // The adapter stores or forwards in its own write: a provider's round trip holds no kernel transaction.
      const { review } = await reviews.submitReview({
        productId,
        customerId,
        orderId: order?.id ?? null,
        author: {
          name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
          email: customer.email,
        },
        rating: input.rating,
        title: input.title,
        body: input.body,
      })

      await store.transaction(async () => {
        audit.note('review.submit', [{ type: 'review', id: review.id }])
        await publisher.publish(EVT_REVIEW_SUBMITTED, {
          reviewId: review.id,
          productId: review.productId,
          customerId,
          orderId: review.orderId,
          rating: review.rating,
        })
      })
      logger.debug({ reviewId: review.id, productId }, 'review submitted')
      return review
    },
  }
}
