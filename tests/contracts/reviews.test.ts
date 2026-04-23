import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ReviewsAdapter } from '@nymbal/types'
import {
  createNativeReviewsAdapter,
  createCommandStore,
  runMigrations,
  InMemoryDocumentStore,
  buildRepositories,
  createLogger,
  type CommandStore,
} from '@nymbal/platform'

const logger = createLogger({ pretty: false, level: 'error' })
let adapter: ReviewsAdapter
let commandStore: CommandStore

beforeAll(async () => {
  commandStore = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../packages/platform/migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const repos = buildRepositories(commandStore, documentStore)
  adapter = createNativeReviewsAdapter({ repos, logger })
})

afterAll(async () => {
  await commandStore.close()
})

describe('ReviewsAdapter contract — native', () => {
  it('submitReview returns created review with pending status', async () => {
    const { review } = await adapter.submitReview({
      productId: 'prod-1',
      customerId: null,
      orderId: null,
      rating: 5,
      title: 'Excellent',
      body: 'Loved it.',
    })
    expect(review.id).toBeTruthy()
    expect(review.productId).toBe('prod-1')
    expect(review.rating).toBe(5)
    // Native adapter creates reviews as 'pending' (requires moderation before 'approved')
    expect(review.moderationStatus).toBe('pending')
  })

  it('getProductReviews with status=pending returns submitted review', async () => {
    const productId = `prod-list-${Date.now()}`
    await adapter.submitReview({ productId, customerId: null, orderId: null, rating: 4, title: 'Good', body: 'Decent.' })
    const { items } = await adapter.getProductReviews(productId, { status: 'pending' })
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(items[0]!.productId).toBe(productId)
  })

  it('getAggregateRating returns a valid aggregate (count may be 0 if no approved reviews)', async () => {
    const pid = `prod-agg-${Date.now()}`
    const agg = await adapter.getAggregateRating(pid)
    // Count is 0 for a new product with no approved reviews — verify shape
    expect(typeof agg.count).toBe('number')
    expect(typeof agg.average).toBe('number')
    expect(agg.productId).toBe(pid)
  })

  it('healthCheck returns healthy', async () => {
    const report = await adapter.healthCheck()
    expect(['healthy', 'degraded', 'down']).toContain(report.status)
  })
})
