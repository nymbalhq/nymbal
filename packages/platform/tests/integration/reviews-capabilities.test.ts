import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { ReviewsAdapter } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'

// GET /api/capabilities tells a storefront what the store's reviews adapter can do, from the adapter's own answer, so
// a store whose provider takes no on-site reviews can leave the form off its product page.

interface ReviewsReport {
  reviews?: { capabilities?: unknown }
}

async function reportOf(served: ServedKernel): Promise<ReviewsReport> {
  const res = await fetch(`${served.baseUrl}/api/capabilities`, {
    headers: { accept: 'application/json' },
  })
  const text = await res.text()
  expect(res.status, text.slice(0, 300)).toBe(200)
  return (JSON.parse(text) as { data: ReviewsReport }).data
}

/** A reviews adapter of the project's own, reporting `caps`; it stores nothing. */
function injectedReviews(providerName: string, caps: string[]): ReviewsAdapter {
  return {
    kind: 'reviews',
    providerName,
    capabilities: () => caps,
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' }),
    getProductReviews: async () => ({ items: [], nextCursor: null }),
    getAggregateRating: async (productId) => ({
      productId,
      average: 0,
      count: 0,
      histogram: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    }),
    submitReview: async () => {
      throw new Error('this fake takes no reviews')
    },
    requestReview: async () => undefined,
  }
}

const withCustomReviews = (config: NymbalConfig): NymbalConfig => ({
  ...config,
  commerce: { ...config.commerce, reviews: { provider: 'custom' } },
})

describe('the capabilities report carries the reviews adapter’s answer', () => {
  let native: ServedKernel

  beforeAll(async () => {
    native = await serveKernel(await createKernel({ dialect: 'sqlite' }))
  }, 60_000)

  afterAll(async () => {
    await native?.stop()
  })

  // Kills: no reviews entry in the report, or one that is not the adapter's.
  it('AC-8: on the native store, GET /api/capabilities answers reviews.capabilities equal to the native adapter’s capabilities(), submit among them', async () => {
    const report = await reportOf(native)
    const own = [...native.kernel.app.adapters.reviews.capabilities()]

    expect(report.reviews?.capabilities).toEqual(own)
    expect(own.includes('submit')).toBe(true)
  })

  const opened: ServedKernel[] = []

  afterEach(async () => {
    for (const s of opened.splice(0)) await s.stop()
  })

  // Kills: a fixed list (the native one) served whatever the adapter, or the provider's name leaking into the report.
  it('AC-8: property: over generated capability sets of an injected reviews adapter, the report’s reviews.capabilities equal the adapter’s answer and name no provider', async () => {
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(['submit', 'moderate', 'aggregate', 'invite', 'widget']),
        async (caps) => {
          run += 1
          const providerName = `caps-reviews-${run}`
          const served = await serveKernel(
            await createKernel({
              dialect: 'sqlite',
              configure: withCustomReviews,
              appOptions: { adapters: { reviews: injectedReviews(providerName, caps) } },
            }),
          )
          opened.push(served)

          const report = await reportOf(served)

          expect(report.reviews?.capabilities, JSON.stringify(caps)).toEqual(caps)
          expect(JSON.stringify(report).includes(providerName)).toBe(false)
          await opened.pop()!.stop()
        },
      ),
      { numRuns: 8, examples: [[[]], [['aggregate', 'widget']]] },
    )
  }, 180_000)
})
