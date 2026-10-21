import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Review, ReviewsAdapter, ReviewsResult } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

// Every case seeds under a product of its own, and reads what it seeded with the moderation status the adapter
// reported on submitReview: one that files reviews for moderation reads them as pending, one that auto-approves as
// approved.

async function seed(adapter: ReviewsAdapter, count: number): Promise<Review[]> {
  const productId = `contract-reviews-${randomUUID()}`
  const seeded: Review[] = []
  for (let i = 0; i < count; i++) {
    const { review } = await adapter.submitReview({
      productId,
      customerId: null,
      orderId: null,
      rating: (i % 5) + 1,
      title: `review ${i}`,
      body: `body ${i}`,
    })
    seeded.push(review)
  }
  return seeded
}

/** Every page from page 1, stopping after `maxPages`: a cursor that never ends shows as a walk that long. */
async function walk(
  adapter: ReviewsAdapter,
  first: Review,
  limit: number,
  maxPages: number,
): Promise<ReviewsResult[]> {
  const pages: ReviewsResult[] = []
  let cursor: string | undefined
  do {
    const page = await adapter.getProductReviews(first.productId, {
      limit,
      status: first.moderationStatus,
      ...(cursor !== undefined && { cursor }),
    })
    pages.push(page)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined && pages.length < maxPages)
  return pages
}

export function runReviewsContract(
  name: string,
  build: Build<ReviewsAdapter>,
  options: ContractOptions<ReviewsAdapter> = {},
): void {
  describe(`ReviewsAdapter contract: ${name}`, () => {
    it(
      'submitReview returns the created review',
      async () => {
        const adapter = await build()
        const productId = `contract-reviews-${randomUUID()}`
        const { review } = await adapter.submitReview({
          productId,
          customerId: null,
          orderId: null,
          rating: 5,
          title: 'Great!',
          body: 'Really liked it.',
        })
        expect(review.productId).toBe(productId)
        expect(review.rating).toBe(5)
        expect(review.id).toBeTruthy()
      },
      CASE_MS,
    )

    it(
      'getProductReviews returns the submitted review, read under the status submitReview reported',
      async () => {
        const adapter = await build()
        const [review] = await seed(adapter, 1)
        const { items } = await adapter.getProductReviews(review!.productId, {
          status: review!.moderationStatus,
        })
        expect(items.map((r) => r.id)).toEqual([review!.id])
        expect(items[0]!.productId).toBe(review!.productId)
      },
      CASE_MS,
    )

    it(
      'getAggregateRating is consistent: its histogram sums to its count, and an approved review is counted',
      async () => {
        const adapter = await build()
        const [review] = await seed(adapter, 1)
        const agg = await adapter.getAggregateRating(review!.productId)
        expect(agg.productId).toBe(review!.productId)
        expect(Object.values(agg.histogram).reduce((a, b) => a + b, 0)).toBe(agg.count)
        if (agg.count === 0) expect(agg.average).toBe(0)
        else {
          expect(agg.average).toBeGreaterThanOrEqual(1)
          expect(agg.average).toBeLessThanOrEqual(5)
        }
        if (review!.moderationStatus === 'approved') expect(agg.count).toBeGreaterThanOrEqual(1)
      },
      CASE_MS,
    )

    // Kills: an adapter that ignores the cursor (page 1 again), returns no next cursor after the first page, or
    // repeats or skips a review between pages.
    it(
      'pagination: over seeds larger than a page, the cursor walk from page 1 yields each review once, the walk is the seed, no page exceeds limit and nextCursor is null exactly on the last page',
      async () => {
        const adapter = await build()
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 5 }),
            fc.integer({ min: 1, max: 8 }),
            async (limit, extra) => {
              const seeded = await seed(adapter, limit + extra)
              const status = seeded[0]!.moderationStatus
              const expected = seeded.filter((r) => r.moderationStatus === status).map((r) => r.id)
              const pages = await walk(
                adapter,
                seeded[0]!,
                limit,
                Math.ceil(expected.length / limit) + 2,
              )
              const walked = pages.flatMap((p) => p.items.map((r) => r.id))

              expect(new Set(walked).size, 'a review came back on two pages').toBe(walked.length)
              expect([...walked].sort()).toEqual([...expected].sort())
              for (const page of pages) expect(page.items.length).toBeLessThanOrEqual(limit)
              expect(pages.map((p) => p.nextCursor === null)).toEqual(
                pages.map((_, i) => i === pages.length - 1),
              )
            },
          ),
          { numRuns: 15 },
        )
      },
      120_000,
    )

    healthAndDowntime(build, options.unreachable, 'getProductReviews()', (adapter) =>
      adapter.getProductReviews(`contract-reviews-${randomUUID()}`, { limit: 1 }),
    )
  })
}
