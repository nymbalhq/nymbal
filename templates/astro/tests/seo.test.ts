import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { DenormalisedProduct, ProductRating } from '@nymbalhq/sdk'
import { productJsonLd } from '../src/lib/seo'

// The product page's JSON-LD carries the rating the page shows, so a search engine can show its stars: an
// `aggregateRating` from the served rating, and none at all for a product without approved reviews (a zero-count
// aggregateRating is invalid structured data).

const BASE = 'https://shop.example.test'

const rated = fc.record({
  average: fc.integer({ min: 10, max: 50 }).map((tenths) => tenths / 10),
  count: fc.integer({ min: 1, max: 100_000 }),
})

/** No rating to mark up: none served, the key absent, or a count of 0. */
const unrated = fc.constantFrom<{ rating?: ProductRating | null }>(
  {},
  { rating: null },
  { rating: { average: 0, count: 0 } },
)

const variant = fc.record({
  id: fc.uuid(),
  sku: fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,4}$/),
  name: fc.constant<string>('Default'),
  priceMinor: fc.integer({ min: 0, max: 100_000 }),
  stock: fc.nat({ max: 50 }),
  options: fc.constant<DenormalisedProduct['variants'][number]['options']>([]),
})

const product = fc.record({
  id: fc.uuid(),
  slug: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/),
  name: fc.stringMatching(/^[A-Z][a-z]{1,10}$/),
  description: fc.string({ maxLength: 40 }),
  shortDescription: fc.constant<string>(''),
  status: fc.constant<string>('active'),
  type: fc.constant<string>('simple'),
  media: fc.constant<unknown>([]),
  variantCount: fc.constant<number>(1),
  inStock: fc.boolean(),
  priceRange: fc.constant<DenormalisedProduct['priceRange']>(null),
  currency: fc.constant<string | null>('GBP'),
  priceMinor: fc.integer({ min: 0, max: 100_000 }),
  variants: fc.array(variant, { minLength: 1, maxLength: 3 }),
  categoryIds: fc.constant<string[]>([]),
  categories: fc.constant<DenormalisedProduct['categories']>([]),
  createdAt: fc.constant<string>('2026-11-01T00:00:00.000Z'),
  updatedAt: fc.constant<string>('2026-11-01T00:00:00.000Z'),
}) satisfies fc.Arbitrary<DenormalisedProduct>

describe('productJsonLd aggregateRating (astro)', () => {
  // Kills: no aggregateRating for a rated product, or one with other figures than the page shows.
  it('AC-6: property: for a product with a rating of count > 0, aggregateRating is { @type AggregateRating, ratingValue: average, reviewCount: count, bestRating 5, worstRating 1 }', () => {
    fc.assert(
      fc.property(product, rated, (p, rating) => {
        const ld = productJsonLd({ ...p, rating }, BASE) as Record<string, unknown>
        expect(ld.aggregateRating).toEqual({
          '@type': 'AggregateRating',
          ratingValue: rating.average,
          reviewCount: rating.count,
          bestRating: 5,
          worstRating: 1,
        })
      }),
      { numRuns: 60 },
    )
  })

  // Kills: a zero-count aggregateRating, which search engines reject as invalid.
  it('AC-6: property: for a product whose rating is null, absent or count 0, the JSON-LD has no aggregateRating key and is otherwise the same as with a rating', () => {
    fc.assert(
      fc.property(product, unrated, rated, (p, none, rating) => {
        const without = productJsonLd({ ...p, ...none }, BASE) as Record<string, unknown>
        const withRating = productJsonLd({ ...p, rating }, BASE) as Record<string, unknown>
        expect('aggregateRating' in without, JSON.stringify(none)).toBe(false)
        const { aggregateRating: _shown, ...rest } = withRating
        expect(without).toEqual(rest)
      }),
      { numRuns: 60 },
    )
  })
})
