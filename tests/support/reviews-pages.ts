import { randomUUID } from 'node:crypto'
import type { ReviewsAdapter, ReviewsResult } from '../../packages/types/src/index.js'

// P2-13 AC-3 support (spec P2-13-contract-tests-public, decision 4, Fable spec B2): seed one product's reviews through
// the adapter and walk them back by cursor, so a runner can hold the native adapter's keyset pagination to the walk's
// relations. Each seed is under a product of its own, so no walk needs a truncated store. The native adapter files a
// submitted review as `pending`, so the walk reads that status.

export interface Seeded {
  productId: string
  ids: string[]
}

export async function seedReviews(adapter: ReviewsAdapter, count: number): Promise<Seeded> {
  const productId = `p2-13-reviews-${randomUUID()}`
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const { review } = await adapter.submitReview({
      productId,
      customerId: null,
      orderId: null,
      rating: (i % 5) + 1,
      title: `review ${i}`,
      body: `body ${i}`,
    })
    ids.push(review.id)
  }
  return { productId, ids }
}

/** Every page of the product's pending reviews from page 1, stopping after `maxPages` (a cursor that never ends). */
export async function walkReviews(
  adapter: ReviewsAdapter,
  productId: string,
  limit: number,
  maxPages: number,
): Promise<ReviewsResult[]> {
  const pages: ReviewsResult[] = []
  let cursor: string | undefined
  do {
    const page = await adapter.getProductReviews(productId, {
      limit,
      status: 'pending',
      ...(cursor !== undefined && { cursor }),
    })
    pages.push(page)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined && pages.length < maxPages)
  return pages
}
