import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../http.js'
import type { Kernel } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'
import { productIn, reviewer, reviewRows } from '../reviews.js'

// Invariant: one review per customer and product. Concurrent POST /api/reviews by one customer for one product, over
// HTTP on one dialect: one is accepted, the rest are refused as already reviewed, and one row is left; the same
// customer's review of another product is unaffected.

export interface ReviewsOnceSuiteOptions {
  /** fast-check runs of the concurrent submissions. */
  propertyRuns: number
}

export function reviewsOnceSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: ReviewsOnceSuiteOptions,
): void {
  describe(`one review per customer and product (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    // Kills: find-then-insert without a lock, or no check at all, so k parallel submissions make k reviews.
    it(`AC-6: property: k = 2-6 parallel POST /api/reviews by one customer for one product answer exactly one 200 and k - 1 409 reviews.already_reviewed, leave one row, and the same customer then reviews another product with 200 (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 6 }),
          fc.integer({ min: 1, max: 5 }),
          async (contenders, rating) => {
            const who = await reviewer(served.baseUrl)
            const productId = await productIn(k, 'active')
            const another = await productIn(k, 'active')
            const body = (id: string) => ({
              productId: id,
              rating,
              title: 'Once',
              body: 'Only once.',
            })

            const answers = await Promise.all(
              Array.from({ length: contenders }, () => who.submit(body(productId))),
            )

            const label = `k=${contenders}: ${JSON.stringify(answers.map((a) => [a.status, a.body.error?.code]))}`
            const accepted = answers.filter((a) => a.status === 200)
            expect(accepted.length, label).toBe(1)
            expect(
              answers.filter((a) => a.status !== 200).map((a) => [a.status, a.body.error?.code]),
              label,
            ).toEqual(
              Array.from({ length: contenders - 1 }, () => [409, 'reviews.already_reviewed']),
            )
            expect(
              (await reviewRows(raw, productId, who.id)).map((r) => r.id),
              label,
            ).toEqual([accepted[0]!.body.data!.review.id])

            const elsewhere = await who.submit(body(another))
            expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(200)
            expect((await reviewRows(raw, another, who.id)).length).toBe(1)
          },
        ),
        { numRuns: opts.propertyRuns },
      )
    }, 180_000)
  })
}
