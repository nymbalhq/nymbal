export type ReviewModerationStatus = 'pending' | 'approved' | 'rejected'

export interface Review {
  id: string
  productId: string
  customerId: string | null
  orderId: string | null
  rating: number
  title: string
  body: string
  moderationStatus: ReviewModerationStatus
  submittedAt: string
  moderatedAt: string | null
  moderatedBy: string | null
}

/** A review as the public list publishes it: no customer or order id, only whether a purchase verified it. */
export interface PublicReview {
  id: string
  productId: string
  rating: number
  title: string
  body: string
  verified: boolean
  submittedAt: string
}

export interface PublicReviewsResult {
  items: PublicReview[]
  nextCursor: string | null
}

/** A product's rating as the product routes serve it: the average to one decimal and the approved review count. */
export interface ProductRating {
  average: number
  count: number
}

export interface AggregateRating {
  productId: string
  average: number
  count: number
  histogram: Record<'1' | '2' | '3' | '4' | '5', number>
}
