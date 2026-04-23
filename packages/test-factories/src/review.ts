import type { Review, ReviewModerationStatus } from '@nymbal/types'
import { nextId, isoDate, randInt } from './prng.js'

export function createReview(overrides?: Partial<Review>): Review {
  return {
    id: nextId(),
    productId: nextId(),
    customerId: null,
    orderId: null,
    rating: randInt(1, 5),
    title: 'Great product',
    body: 'Really enjoyed using this product.',
    moderationStatus: 'approved' as ReviewModerationStatus,
    submittedAt: isoDate(),
    moderatedAt: isoDate(),
    moderatedBy: null,
    ...overrides,
  }
}
