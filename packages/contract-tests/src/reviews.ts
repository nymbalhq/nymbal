import { describe, it, expect } from 'vitest'
import type { ReviewsAdapter } from '@nymbal/types'

export function runReviewsContract(build: () => ReviewsAdapter): void {
  describe('ReviewsAdapter contract', () => {
    it('submitReview returns the created review', async () => {
      const adapter = build()
      const { review } = await adapter.submitReview({
        productId: 'prod-1',
        customerId: null,
        orderId: null,
        rating: 5,
        title: 'Great!',
        body: 'Really liked it.',
      })
      expect(review.productId).toBe('prod-1')
      expect(review.rating).toBe(5)
      expect(review.id).toBeTruthy()
    })

    it('getProductReviews returns submitted reviews', async () => {
      const adapter = build()
      await adapter.submitReview({
        productId: 'prod-reviews-2',
        customerId: null,
        orderId: null,
        rating: 4,
        title: 'Good',
        body: 'Decent product.',
      })
      const { items } = await adapter.getProductReviews('prod-reviews-2')
      expect(items.length).toBeGreaterThanOrEqual(1)
      expect(items[0]!.productId).toBe('prod-reviews-2')
    })

    it('getAggregateRating reflects submitted reviews', async () => {
      const adapter = build()
      const productId = `prod-agg-${Date.now()}`
      await adapter.submitReview({ productId, customerId: null, orderId: null, rating: 4, title: 'A', body: 'B' })
      const agg = await adapter.getAggregateRating(productId)
      expect(agg.productId).toBe(productId)
      expect(agg.count).toBeGreaterThanOrEqual(1)
      expect(agg.average).toBeGreaterThan(0)
    })

    it('healthCheck returns a valid report', async () => {
      const adapter = build()
      const report = await adapter.healthCheck()
      expect(['healthy', 'degraded', 'down']).toContain(report.status)
    })
  })
}
