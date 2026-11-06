import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { AggregateRating, ReviewsAdapter, ReviewsCapability } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import {
  catalogueOf,
  expectedRoutes,
  routesServing,
  servedItems,
  viewerOf,
  type Catalogue,
  type ServedItem,
} from '../support/product-ratings.js'
import { liftedViewLimit, type Shop } from '../support/recently-viewed.js'

// A store on a reviews provider of its own (`provider: 'custom'`): the product routes serve the provider's figures,
// ask nothing of a provider that does not report `aggregate`, and serve the catalogue without a rating when the
// provider fails.

const EMPTY_HISTOGRAM = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }

/** How the injected provider answers `getAggregateRating`, set by each case. */
type Answer = { kind: 'figures'; average: number; count: number } | { kind: 'rejects' }

interface Provider {
  adapter: ReviewsAdapter
  /** The answer for every product, unless `answerFor` names one. */
  answer: Answer
  answerFor: Map<string, Answer>
  /** The product ids `getAggregateRating` was asked for, in order. */
  asked: string[]
}

function provider(caps: ReviewsCapability[]): Provider {
  const p: Provider = {
    answer: { kind: 'figures', average: 4.25, count: 7 },
    answerFor: new Map(),
    asked: [],
    adapter: {
      kind: 'reviews',
      providerName: 'ratings-provider',
      capabilities: () => caps,
      producesEvents: [],
      consumesEvents: [],
      initialize: async () => undefined,
      healthCheck: async () => ({ status: 'healthy' }),
      getProductReviews: async () => ({ items: [], nextCursor: null }),
      getAggregateRating: async (productId): Promise<AggregateRating> => {
        p.asked.push(productId)
        const answer = p.answerFor.get(productId) ?? p.answer
        if (answer.kind === 'rejects') throw new Error('the reviews provider is down')
        return {
          productId,
          average: answer.average,
          count: answer.count,
          histogram: EMPTY_HISTOGRAM,
        }
      },
      submitReview: async () => {
        throw new Error('this provider takes no reviews')
      },
      requestReview: async () => undefined,
    },
  }
  return p
}

const withCustomReviews = (config: NymbalConfig): NymbalConfig =>
  liftedViewLimit({ ...config, commerce: { ...config.commerce, reviews: { provider: 'custom' } } })

interface Store {
  served: ServedKernel
  provider: Provider
  catalogue: Catalogue
  viewer: Shop
}

async function storeOn(caps: ReviewsCapability[]): Promise<Store> {
  const p = provider(caps)
  const served = await serveKernel(
    await createKernel({
      dialect: 'sqlite',
      configure: withCustomReviews,
      appOptions: { adapters: { reviews: p.adapter } },
    }),
  )
  const catalogue = await catalogueOf(served.kernel, 3)
  const viewer = await viewerOf(served.baseUrl, catalogue)
  return { served, provider: p, catalogue, viewer }
}

async function read(store: Store): Promise<ServedItem[]> {
  const items = await servedItems(store.served.baseUrl, store.catalogue, store.viewer)
  for (const p of store.catalogue.products) {
    expect(routesServing(items, p.id), `routes serving ${p.slug}`).toEqual(
      expectedRoutes(store.catalogue, p.slug),
    )
  }
  return items
}

const ratingsOf = (items: ServedItem[]) => items.map((i) => [i.route, i.slug, i.rating])
const allRated = (items: ServedItem[], rating: unknown) =>
  items.map((i) => [i.route, i.slug, rating])

describe('a provider without aggregate', () => {
  let store: Store

  beforeAll(async () => {
    store = await storeOn(['submit', 'moderate'])
  }, 60_000)

  afterAll(async () => {
    await store?.served.stop()
  })

  // Kills: a provider that does not report aggregate asked anyway, or its answer shown.
  it('AC-3: with a reviews provider lacking aggregate, the four product routes serve rating null and getAggregateRating is never called', async () => {
    store.provider.asked.length = 0
    const items = await read(store)

    expect(ratingsOf(items)).toEqual(allRated(items, null))
    expect(store.provider.asked).toEqual([])
  })
})

describe('a provider with aggregate', () => {
  let store: Store

  beforeAll(async () => {
    store = await storeOn(['aggregate'])
  }, 60_000)

  afterAll(async () => {
    await store?.served.stop()
  })

  function answer(a: Answer, answerFor: Array<[string, Answer]> = []): void {
    store.provider.answer = a
    store.provider.answerFor = new Map(answerFor)
  }

  // Kills: the provider's figures not passed through, or not rounded to one decimal.
  it('AC-3: a provider answering { average: 4.25, count: 7 } is served as rating { average: 4.3, count: 7 } on every item of the four routes', async () => {
    answer({ kind: 'figures', average: 4.25, count: 7 })
    const items = await read(store)

    expect(ratingsOf(items)).toEqual(allRated(items, { average: 4.3, count: 7 }))
  })

  // Kills: a provider's zero-count answer served as a rating of 0 from 0 reviews.
  it('AC-3: a provider answering count 0 is served as rating null on every item of the four routes', async () => {
    answer({ kind: 'figures', average: 0, count: 0 })
    const items = await read(store)

    expect(ratingsOf(items)).toEqual(allRated(items, null))
  })

  // Kills: a provider's out-of-range average served as a rating no star display can show.
  it('AC-3: a provider answering an average outside 1 to 5 with a count is served as rating null', async () => {
    for (const average of [0, 0.5, 5.5]) {
      answer({ kind: 'figures', average, count: 3 })
      const items = await read(store)

      expect(ratingsOf(items), `average ${average}`).toEqual(allRated(items, null))
    }
  })

  // Kills: a provider outage that fails the catalogue (a 500 for every listing), or that serves fewer items.
  it('AC-3: with a getAggregateRating that rejects, the four routes answer 200 with the same items as with a working provider, each rating null', async () => {
    answer({ kind: 'figures', average: 4.25, count: 7 })
    const working = await read(store)

    answer({ kind: 'rejects' })
    const failing = await read(store)

    expect(failing.map((i) => [i.route, i.rest])).toEqual(working.map((i) => [i.route, i.rest]))
    expect(ratingsOf(failing)).toEqual(allRated(failing, null))
  })

  // Kills: one product's failure nulling the whole page's ratings, or failing the page.
  it('AC-3: with a getAggregateRating that rejects for one product only and answers { average: 4.25, count: 7 } for the rest, that product is served rating null and every other item { average: 4.3, count: 7 }', async () => {
    const failingId = store.catalogue.products[1]!.id
    answer({ kind: 'figures', average: 4.25, count: 7 }, [[failingId, { kind: 'rejects' }]])
    const items = await read(store)

    expect(ratingsOf(items)).toEqual(
      items.map((i) => [i.route, i.slug, i.id === failingId ? null : { average: 4.3, count: 7 }]),
    )
    expect(items.filter((i) => i.id === failingId).length).toBe(
      expectedRoutes(store.catalogue, store.catalogue.products[1]!.slug).length,
    )
  })
})
