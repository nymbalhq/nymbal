import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Review, ReviewsAdapter, ReviewsResult, ReviewSubmission } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, settle, type Build, type ContractOptions } from './common.js'

// Every case seeds under a product of its own, and reads what it seeded with the moderation status the seed came back
// with: one that files reviews for moderation reads them as pending, one that auto-approves as approved. An adapter
// with `submit` among its capabilities is seeded through submitReview unless the caller gives `seed`; one without it
// (a provider that collects reviews by invitation or on its own site) takes no review from the kernel, refuses
// submitReview, and is seeded through `seed`.

export interface ReviewsContractOptions extends ContractOptions<ReviewsAdapter> {
  /**
   * Puts `count` reviews of `productId` in the adapter's store, by whatever way reviews reach it, and returns them.
   * Required when `submit` is not among the adapter's capabilities.
   */
  seed?: (adapter: ReviewsAdapter, productId: string, count: number) => Promise<Review[]>
}

const takesSubmissions = (adapter: ReviewsAdapter): boolean =>
  adapter.capabilities().includes('submit')

async function seedWith(
  adapter: ReviewsAdapter,
  count: number,
  options: ReviewsContractOptions,
): Promise<Review[]> {
  const productId = `contract-reviews-${randomUUID()}`
  if (options.seed !== undefined) return options.seed(adapter, productId, count)
  if (!takesSubmissions(adapter)) {
    throw new Error(
      'runReviewsContract: an adapter without the submit capability needs the seed option to put reviews in its store',
    )
  }
  const seeded: Review[] = []
  for (let i = 0; i < count; i++) {
    const { review } = await adapter.submitReview({
      productId,
      customerId: null,
      orderId: null,
      author: null,
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

const arbSubmission: fc.Arbitrary<ReviewSubmission> = fc.record({
  productId: fc.uuid().map((id) => `contract-reviews-${id}`),
  customerId: fc.option(
    fc.uuid().map((id) => `contract-customer-${id}`),
    { nil: null },
  ),
  orderId: fc.option(
    fc.uuid().map((id) => `contract-order-${id}`),
    { nil: null },
  ),
  author: fc.option(
    fc.record({
      name: fc.stringMatching(/^[A-Z][a-z]{1,10} [A-Z][a-z]{1,12}$/),
      email: fc.stringMatching(/^[a-z]{3,10}@contract\.test$/),
    }),
    { nil: null },
  ),
  rating: fc.integer({ min: 1, max: 5 }),
  title: fc.stringMatching(/^[A-Z][a-z]{2,10}( [a-z]{2,8}){0,3}$/),
  body: fc.stringMatching(/^[A-Z][a-z]{2,10}( [a-z]{2,8}){0,8}\.$/),
})

export function runReviewsContract(
  name: string,
  build: Build<ReviewsAdapter>,
  options: ReviewsContractOptions = {},
): void {
  const seed = (adapter: ReviewsAdapter, count: number) => seedWith(adapter, count, options)

  describe(`ReviewsAdapter contract: ${name}`, () => {
    // Kills: an adapter that files a review as someone else's or drops the purchase it was verified by (the kernel
    // resolves both; the adapter only stores or forwards them), and one that reports no submit capability yet takes
    // the review anyway, where a store's form would be hidden for nothing.
    it(
      'submit: with submit among its capabilities, submitReview returns the review carrying the submission’s productId, customerId, orderId, rating, title and body; without it, submitReview rejects with ReviewRefusedError reviews.submit_unsupported',
      async () => {
        const adapter = await build()
        const takes = takesSubmissions(adapter)
        await fc.assert(
          fc.asyncProperty(arbSubmission, async (submission) => {
            const answer = await settle(() => adapter.submitReview(submission))
            if (takes) {
              expect(answer.state, JSON.stringify(answer)).toBe('resolved')
              const { review } = (answer as { value: { review: Review } }).value
              expect([
                review.productId,
                review.customerId,
                review.orderId,
                review.rating,
                review.title,
                review.body,
              ]).toEqual([
                submission.productId,
                submission.customerId,
                submission.orderId,
                submission.rating,
                submission.title,
                submission.body,
              ])
            } else {
              expect(answer.state, 'submitReview of an adapter without submit').toBe('rejected')
              const error = (answer as { error: { name?: unknown; code?: unknown } }).error
              expect({ name: error?.name, code: error?.code }).toEqual({
                name: 'ReviewRefusedError',
                code: 'reviews.submit_unsupported',
              })
            }
          }),
          { numRuns: 10 },
        )
      },
      CASE_MS,
    )

    it(
      'getProductReviews returns the seeded review, read under the status it was seeded with',
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
