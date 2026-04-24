import type { ReviewSubmission } from '@nymbal/types'
import type { WcReview } from '../client.js'

export function mapReview(
  wc: WcReview,
  nymbalProductId: string,
  nymbalCustomerId: string | null,
): ReviewSubmission {
  return {
    productId: nymbalProductId,
    customerId: nymbalCustomerId,
    orderId: null,
    rating: Math.min(5, Math.max(1, wc.rating)),
    title: '',
    body: wc.review.replace(/<[^>]+>/g, '').trim(),
  }
}
