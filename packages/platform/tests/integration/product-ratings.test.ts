import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ReviewModerationStatus } from '@nymbalhq/types'
import { adminSession, type AdminSession } from '../support/audit-http.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import {
  catalogueOf,
  expectedRoutes,
  round1,
  routesServing,
  servedItems,
  viewerOf,
  type ServedItem,
} from '../support/product-ratings.js'
import { liftedViewLimit } from '../support/recently-viewed.js'

// Invariant: a rating the product routes serve is null or the native adapter's figures for the approved reviews.
// Reviews are submitted through the native reviews adapter and moderated over HTTP by an admin; every product route
// is read over HTTP on a served SQLite kernel.

interface GeneratedReview {
  rating: number
  status: ReviewModerationStatus
}

let served: ServedKernel
let admin: AdminSession

beforeAll(async () => {
  served = await serveKernel(await createKernel({ dialect: 'sqlite', configure: liftedViewLimit }))
  admin = await adminSession(served.kernel, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await served?.stop()
})

/** Submits a review of the product through the native adapter and moderates it over HTTP unless it stays pending. */
async function review(productId: string, r: GeneratedReview): Promise<void> {
  const { review: submitted } = await served.kernel.app.adapters.reviews.submitReview({
    productId,
    customerId: null,
    orderId: null,
    author: null,
    rating: r.rating,
    title: 'Rated',
    body: 'A review of the ratings test.',
  })
  if (r.status === 'pending') return
  const moderated = await admin.send('POST', `/api/admin/reviews/${submitted.id}/moderate`, {
    status: r.status,
  })
  expect(moderated.status, JSON.stringify(moderated.body)).toBe(200)
}

/** The rating the routes must serve for a product with these reviews: the approved ones', or null for none. */
function expectedRating(reviews: readonly GeneratedReview[]) {
  const approved = reviews.filter((r) => r.status === 'approved').map((r) => r.rating)
  if (approved.length === 0) return null
  return {
    average: round1(approved.reduce((n, v) => n + v, 0) / approved.length),
    count: approved.length,
  }
}

const generatedReview = fc.record({
  rating: fc.integer({ min: 1, max: 5 }),
  status: fc.constantFrom<ReviewModerationStatus>('pending', 'approved', 'rejected'),
})

/** Each served item as [route, id, rating], and the same list with the rating each product must have. */
function servedAgainst(items: ServedItem[], expected: Map<string, unknown>) {
  return {
    served: items.map((i) => [i.route, i.id, i.rating]),
    wanted: items.map((i) => [i.route, i.id, expected.has(i.id) ? expected.get(i.id) : null]),
  }
}

describe('the product routes serve each product’s approved rating (sqlite)', () => {
  // Kills: a route that serves no rating or drops it, pending or rejected reviews counted, `{ count: 0 }` served
  // instead of null, the average not rounded to one decimal, a stale figure kept after an approval.
  it('AC-2: property: over generated products and moderated reviews, every item of GET /api/products (each sort, and ?category=), GET /api/products/search, GET /api/recently-viewed and GET /api/products/:slug carries rating { average: round1(mean of approved), count: approved }, or null with none approved; after one more approval the next read serves the new figures', async () => {
    // Every product this file creates, with the rating it must be served with; earlier runs' products stay listed.
    const expected = new Map<string, unknown>()
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(generatedReview, { maxLength: 4 }), { minLength: 1, maxLength: 4 }),
        fc.nat(),
        fc.integer({ min: 1, max: 5 }),
        async (reviewsPerProduct, pick, extraRating) => {
          const catalogue = await catalogueOf(served.kernel, reviewsPerProduct.length)
          for (const [i, reviews] of reviewsPerProduct.entries()) {
            const id = catalogue.products[i]!.id
            for (const r of reviews) await review(id, r)
            expected.set(id, expectedRating(reviews))
          }
          const viewer = await viewerOf(served.baseUrl, catalogue)
          const label = JSON.stringify(reviewsPerProduct)

          const before = await servedItems(served.baseUrl, catalogue, viewer)
          for (const p of catalogue.products) {
            expect(routesServing(before, p.id), `${label}: routes serving ${p.slug}`).toEqual(
              expectedRoutes(catalogue, p.slug),
            )
          }
          const first = servedAgainst(before, expected)
          expect(first.served, label).toEqual(first.wanted)

          // One more approved review of one product: the next read serves its new figures.
          const index = pick % reviewsPerProduct.length
          const target = catalogue.products[index]!
          const extra: GeneratedReview = { rating: extraRating, status: 'approved' }
          await review(target.id, extra)
          expected.set(target.id, expectedRating([...reviewsPerProduct[index]!, extra]))

          const after = await servedItems(served.baseUrl, catalogue, viewer)
          const second = servedAgainst(after, expected)
          expect(
            second.served,
            `${label}, then ${extraRating} approved for ${target.slug}`,
          ).toEqual(second.wanted)
        },
      ),
      {
        numRuns: 8,
        examples: [
          // Only pending and only rejected: no rating; approved 5 and 4 beside a pending 1: 4.5 from 2.
          [
            [
              [{ rating: 3, status: 'pending' }],
              [{ rating: 2, status: 'rejected' }],
              [
                { rating: 5, status: 'approved' },
                { rating: 4, status: 'approved' },
                { rating: 1, status: 'pending' },
              ],
            ],
            0,
            4,
          ],
        ],
      },
    )
  }, 240_000)
})
