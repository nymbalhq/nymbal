import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AggregateRating, ReviewModerationStatus } from '@nymbalhq/types'
import type { Kernel } from '../kernel.js'
import { productIn } from '../reviews.js'

// Invariant: a product's aggregate rating is exactly its approved reviews, however many there are. Reviews are
// written straight to the command store (the aggregate reads the table, not how a review got there) and the native
// reviews adapter is asked on one dialect.

export interface ReviewAggregateSuiteOptions {
  /** fast-check runs of the generated reviews. */
  propertyRuns: number
}

interface Seeded {
  product: 0 | 1
  rating: number
  status: ReviewModerationStatus
}

/** Inserts the reviews in one transaction, each a second after the one before, in the given order. */
async function insertReviews(
  k: Kernel,
  productIds: readonly string[],
  reviews: readonly Seeded[],
): Promise<void> {
  const start = Date.now() - reviews.length * 1000
  await k.store.transaction(async (tx) => {
    for (const [i, r] of reviews.entries()) {
      await k.repos.review.insert(tx, {
        id: uuidv7(),
        productId: productIds[r.product]!,
        customerId: null,
        orderId: null,
        rating: r.rating,
        title: `Review ${i}`,
        body: 'Seeded for the aggregate.',
        moderationStatus: r.status,
        submittedAt: new Date(start + i * 1000),
      })
    }
  })
}

/** What the aggregate must be, from the reviews of one product: the approved ones only. */
function expectedOf(reviews: readonly Seeded[], product: 0 | 1) {
  const approved = reviews.filter((r) => r.product === product && r.status === 'approved')
  const histogram = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  for (const r of approved) histogram[String(r.rating) as keyof typeof histogram] += 1
  const sum = approved.reduce((n, r) => n + r.rating, 0)
  return {
    count: approved.length,
    average: approved.length === 0 ? 0 : sum / approved.length,
    histogram,
  }
}

function expectAggregate(
  got: AggregateRating,
  want: ReturnType<typeof expectedOf>,
  label: string,
): void {
  expect(got.count, `${label}: count`).toBe(want.count)
  expect(typeof got.average, `${label}: average is a number`).toBe('number')
  expect(
    Math.abs(got.average - want.average),
    `${label}: average ${got.average} vs ${want.average}`,
  ).toBeLessThan(1e-9)
  expect(got.histogram, `${label}: histogram`).toEqual(want.histogram)
  const histogramTotal = Object.values(got.histogram).reduce((n, v) => n + v, 0)
  expect(histogramTotal, `${label}: the histogram sums to count`).toBe(got.count)
}

export function reviewAggregateSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: ReviewAggregateSuiteOptions,
): void {
  describe(`a product's aggregate rating is its approved reviews (${dialect})`, () => {
    let k: Kernel

    beforeAll(async () => {
      k = await start()
    }, 60_000)

    afterAll(async () => {
      await k?.close()
    })

    const seeded = fc.record({
      product: fc.constantFrom<0 | 1>(0, 1),
      rating: fc.integer({ min: 1, max: 5 }),
      status: fc.constantFrom<ReviewModerationStatus>('pending', 'approved', 'rejected'),
    })

    // Kills: a pending or rejected review counted, another product's review counted, a histogram bucket off by one, an
    // average over the wrong rows, one dialect's branch of the SQL aggregate wrong.
    it(`AC-1: property: over generated reviews of two products, each pending, approved or rejected, getAggregateRating(p) answers count = p's approved reviews, average = their mean (0 when none) and histogram[k] = p's approved reviews rated k, summing to count (${dialect})`, async () => {
      const reviews = k.app.adapters.reviews
      await fc.assert(
        fc.asyncProperty(fc.array(seeded, { maxLength: 30 }), async (generated) => {
          const productIds = [await productIn(k, 'active'), await productIn(k, 'active')] as const
          await insertReviews(k, productIds, generated)
          for (const product of [0, 1] as const) {
            const got = await reviews.getAggregateRating(productIds[product])
            expect(got.productId).toBe(productIds[product])
            expectAggregate(
              got,
              expectedOf(generated, product),
              `product ${product} of ${JSON.stringify(generated)}`,
            )
          }
        }),
        { numRuns: opts.propertyRuns },
      )
    }, 180_000)

    // Kills: the aggregate summing a capped page of reviews (newest first, so the oldest approved fall out of it).
    it(`AC-1: 1,001 approved reviews of one product plus one pending answer count 1,001 and the mean of all 1,001 (${dialect})`, async () => {
      const productIds = [await productIn(k, 'active'), await productIn(k, 'active')] as const
      // The oldest approved review is the only 1, so a newest-first page of 1000 would lose it and average 5.
      const generated: Seeded[] = [
        { product: 0, rating: 1, status: 'approved' },
        ...Array.from(
          { length: 1000 },
          (): Seeded => ({ product: 0, rating: 5, status: 'approved' }),
        ),
        { product: 0, rating: 1, status: 'pending' },
      ]
      await insertReviews(k, productIds, generated)

      const got = await k.app.adapters.reviews.getAggregateRating(productIds[0])

      const want = expectedOf(generated, 0)
      expect(want.count).toBe(1001)
      expectAggregate(got, want, '1,001 approved and one pending')
      expect(got.average).toBeLessThan(5)
    }, 60_000)
  })
}
