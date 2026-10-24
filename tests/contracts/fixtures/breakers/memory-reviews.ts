import { randomUUID } from 'node:crypto'
import type { HealthReport, Review, ReviewsAdapter } from '@nymbalhq/types'

// An in-memory reviews adapter that pages by an offset cursor, and its defective twins (P2-13 AC-3, AC-5): one that
// ignores the cursor (page 1 for every cursor, with a next cursor while more remain), and one whose healthCheck never
// settles. It files every review under every status, so a suite reading any moderation status sees what it submitted.

export interface ReviewsFlaws {
  ignoreCursor?: boolean
  healthHangs?: boolean
}

const encode = (offset: number) => Buffer.from(`o:${offset}`, 'utf8').toString('base64url')

function decode(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  const match = /^o:(\d+)$/.exec(text)
  if (match === null || encode(Number(match[1])) !== cursor) {
    throw new Error(`malformed reviews cursor ${JSON.stringify(cursor)}`)
  }
  return Number(match[1])
}

export function memoryReviews(flaws: ReviewsFlaws = {}): ReviewsAdapter {
  const reviews: Review[] = []
  return {
    kind: 'reviews',
    providerName: 'p2-13-memory-reviews',
    capabilities: () => ['submit', 'aggregate'],
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: () =>
      flaws.healthHangs === true
        ? new Promise<HealthReport>(() => undefined)
        : Promise.resolve({ status: 'healthy' }),

    async getProductReviews(productId, params) {
      const mine = reviews.filter((r) => r.productId === productId)
      const limit = params?.limit ?? 20
      const start =
        params?.cursor === undefined || flaws.ignoreCursor === true ? 0 : decode(params.cursor)
      const end = Math.min(start + limit, mine.length)
      return { items: mine.slice(start, end), nextCursor: end < mine.length ? encode(end) : null }
    },

    async getAggregateRating(productId) {
      const ratings = reviews.filter((r) => r.productId === productId).map((r) => r.rating)
      const histogram = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
      for (const r of ratings) histogram[String(r) as keyof typeof histogram] += 1
      const average = ratings.length === 0 ? 0 : ratings.reduce((a, b) => a + b, 0) / ratings.length
      return { productId, average, count: ratings.length, histogram }
    },

    async submitReview(submission) {
      const review: Review = {
        id: randomUUID(),
        ...submission,
        moderationStatus: 'pending',
        submittedAt: new Date().toISOString(),
        moderatedAt: null,
        moderatedBy: null,
      }
      reviews.push(review)
      return { review }
    },

    async requestReview() {
      return undefined
    },
  }
}
