import { randomUUID } from 'node:crypto'
import type { HealthReport, Review, ReviewsAdapter } from '@nymbalhq/types'

// An in-memory reviews adapter that pages by an offset cursor, and its defective twins: one that ignores the cursor
// (page 1 for every cursor, with a next cursor while more remain), one whose healthCheck never settles, and one that
// files a submitted review without the customer and order the kernel resolved. It files every review under every
// status, so a suite reading any moderation status sees what it submitted. `seedMemoryReviews` puts reviews in its
// store directly, as an import or a provider's own site would.

export interface ReviewsFlaws {
  ignoreCursor?: boolean
  healthHangs?: boolean
  dropsIdentity?: boolean
}

const STORE = Symbol('memory reviews store')

type Stored = ReviewsAdapter & { [STORE]: Review[] }

/** `count` approved reviews of `productId`, put in a memory adapter's store (its spread copies included). */
export async function seedMemoryReviews(
  adapter: ReviewsAdapter,
  productId: string,
  count: number,
): Promise<Review[]> {
  const store = (adapter as Partial<Stored>)[STORE]
  if (store === undefined) throw new Error('seedMemoryReviews: not a memory reviews adapter')
  const seeded = Array.from(
    { length: count },
    (_, i): Review => ({
      id: randomUUID(),
      productId,
      customerId: null,
      orderId: null,
      rating: (i % 5) + 1,
      title: `seeded ${i}`,
      body: `seeded body ${i}`,
      moderationStatus: 'approved',
      submittedAt: new Date().toISOString(),
      moderatedAt: null,
      moderatedBy: null,
    }),
  )
  store.push(...seeded)
  return seeded
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
  const adapter: Stored = {
    [STORE]: reviews,
    kind: 'reviews',
    providerName: 'contracts-memory-reviews',
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
      const { author: _author, ...fields } = submission
      const review: Review = {
        id: randomUUID(),
        ...fields,
        ...(flaws.dropsIdentity === true && { customerId: null, orderId: null }),
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
  return adapter
}
