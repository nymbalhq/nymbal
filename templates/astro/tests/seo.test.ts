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

const GTINS = ['96385074', '036000291452', '4006381333931', '9780306406157', '00012345600012']
/** No brand to mark up: empty or whitespace. */
const NO_BRAND = ['', ' ', '   ', '\t']
const BRAND = fc.stringMatching(/^[A-Z][A-Za-z&' -]{0,20}[a-z]$/)

const variant = fc.record({
  id: fc.uuid(),
  sku: fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,4}$/),
  name: fc.constant<string>('Default'),
  priceMinor: fc.integer({ min: 0, max: 100_000 }),
  stock: fc.nat({ max: 50 }),
  options: fc.constant<DenormalisedProduct['variants'][number]['options']>([]),
  gtin: fc.option(fc.constantFrom(...GTINS), { nil: null }),
})

const product = fc.record({
  id: fc.uuid(),
  slug: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/),
  name: fc.stringMatching(/^[A-Z][a-z]{1,10}$/),
  description: fc.string({ maxLength: 40 }),
  shortDescription: fc.constant<string>(''),
  seoTitle: fc.constant<string>(''),
  seoDescription: fc.constant<string>(''),
  brand: fc.oneof(fc.constantFrom(...NO_BRAND), BRAND),
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

describe('productJsonLd brand and gtin (astro)', () => {
  type Ld = Record<string, unknown>
  /** The product with no identifiers: a blank brand and every variant's gtin null. */
  const bare = (p: DenormalisedProduct): DenormalisedProduct => ({
    ...p,
    brand: '',
    variants: p.variants.map((v) => ({ ...v, gtin: null })),
  })
  /** A variant with no GTIN to mark up: null, the key absent, or empty. */
  const noGtin = fc.constantFrom<'null' | 'absent' | 'empty'>('null', 'absent', 'empty')
  const withoutGtin = (
    v: DenormalisedProduct['variants'][number],
    how: 'null' | 'absent' | 'empty',
  ): DenormalisedProduct['variants'][number] => {
    if (how === 'null') return { ...v, gtin: null }
    if (how === 'empty') return { ...v, gtin: '' }
    const { gtin: _gone, ...rest } = v
    return rest as DenormalisedProduct['variants'][number]
  }

  // Kills: `brand: { name: '' }` emitted for every product (invalid structured data), or the brand dropped.
  it("AC-8: property: a non-blank brand gives brand { '@type': 'Brand', name: <brand> }, and an empty or whitespace brand no brand key", () => {
    fc.assert(
      fc.property(product, BRAND, fc.constantFrom(...NO_BRAND), (p, brand, blank) => {
        const branded = productJsonLd({ ...p, brand }, BASE) as Ld
        const unbranded = productJsonLd({ ...p, brand: blank }, BASE) as Ld
        expect(branded.brand).toEqual({ '@type': 'Brand', name: brand })
        expect(['brand' in unbranded, unbranded.brand], JSON.stringify(blank)).toEqual([
          false,
          undefined,
        ])
      }),
      { numRuns: 60 },
    )
  })

  // Kills: a several-variant page claiming its first variant's GTIN for all of them, or `gtin: null` / `gtin: ''` served.
  it('AC-8: property: exactly one variant holding a GTIN gives top-level gtin equal to it; one variant with a null, absent or empty gtin, and two or more variants each with a GTIN, give no gtin key', () => {
    fc.assert(
      fc.property(
        product,
        variant,
        fc.constantFrom(...GTINS),
        noGtin,
        fc.array(fc.tuple(variant, fc.constantFrom(...GTINS)), { minLength: 2, maxLength: 4 }),
        (p, one, gtin, how, several) => {
          const single = productJsonLd({ ...p, variants: [{ ...one, gtin }] }, BASE) as Ld
          const singleWithout = productJsonLd(
            { ...p, variants: [withoutGtin(one, how)] },
            BASE,
          ) as Ld
          const many = productJsonLd(
            { ...p, variants: several.map(([v, g]) => ({ ...v, gtin: g })) },
            BASE,
          ) as Ld
          expect(single.gtin).toBe(gtin)
          expect(['gtin' in singleWithout, singleWithout.gtin], how).toEqual([false, undefined])
          expect(['gtin' in many, many.gtin], `${several.length} variants`).toEqual([
            false,
            undefined,
          ])
        },
      ),
      { numRuns: 60 },
    )
  })

  // Kills: the identifiers changing any other key of the JSON-LD (sku, offers, url, image), or a key added beside them.
  it('AC-8: property: the JSON-LD of any product is that of the same product with no brand and no GTINs plus exactly its brand (when not blank) and its gtin (when it has one variant holding one)', () => {
    fc.assert(
      fc.property(product, fc.option(rated, { nil: undefined }), (p, rating) => {
        const ld = productJsonLd({ ...p, rating }, BASE) as Ld
        const plain = productJsonLd({ ...bare(p), rating }, BASE) as Ld
        const only = p.variants.length === 1 ? p.variants[0]!.gtin : null
        expect(['brand' in plain, 'gtin' in plain]).toEqual([false, false])
        expect(ld).toEqual({
          ...plain,
          ...(p.brand.trim() !== '' && { brand: { '@type': 'Brand', name: p.brand } }),
          ...(typeof only === 'string' && only !== '' && { gtin: only }),
        })
      }),
      { numRuns: 80 },
    )
  })
})
