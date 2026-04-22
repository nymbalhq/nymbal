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

export interface AggregateRating {
  productId: string
  average: number
  count: number
  histogram: Record<'1' | '2' | '3' | '4' | '5', number>
}
