import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { diffProduct } from '../../src/preview/diff.js'

// What a merchant sees under "Differences": a product WooCommerce sells and the document the preview serves for it,
// compared field by field. Money is read here from WooCommerce's own strings, digit by digit, never through the
// importer's mapper, so a diff that rounds the source first would hide the rounding loss this file looks for.

type Rec = Record<string, unknown>
type Field = 'name' | 'price' | 'variants' | 'images' | 'categories'

const FIELDS: readonly Field[] = ['name', 'price', 'variants', 'images', 'categories']
const CURRENCIES = [
  { code: 'GBP', exp: 2 },
  { code: 'JPY', exp: 0 },
  { code: 'KWD', exp: 3 },
] as const
const CATEGORY_SLUGS = ['kitchen', 'tea', 'matcha', 'mugs', 'sale', 'a', 'b-c', 'zeta']
/** In no source: a served category the source does not have. */
const FOREIGN_SLUG = 'not-in-source'

interface Served {
  name: string
  priceRange: { minMinor: number; maxMinor: number }
  variantCount: number
  media: unknown[]
  categories: Array<{ slug: string }>
}

/** Minor units written to the currency's exponent: 500 at 2 is "5.00", 1500 at 0 is "1500". */
function atExponent(minor: number, exp: number): string {
  if (exp === 0) return String(minor)
  const scale = 10 ** exp
  return `${Math.floor(minor / scale)}.${String(minor % scale).padStart(exp, '0')}`
}

/** How a price range is shown: one amount, or min and max joined by an en dash. */
const shown = (min: string, max: string): string => (min === max ? min : `${min}–${max}`)

/** A WooCommerce price string worth exactly `minor`, sometimes with trailing zeros past the exponent ("12.0", "1500.00"). */
const exactPrice = (exp: number) =>
  fc
    .record({ minor: fc.integer({ min: 0, max: 5_000_000 }), pad: fc.integer({ min: 0, max: 2 }) })
    .map(({ minor, pad }) => {
      const base = atExponent(minor, exp)
      const zeros = '0'.repeat(pad)
      return { minor, text: pad === 0 ? base : exp === 0 ? `${base}.${zeros}` : `${base}${zeros}` }
    })

interface Pair {
  currency: string
  exp: number
  source: { product: Rec; variations: Rec[] }
  served: Served
}

/** A product WooCommerce sells (simple, or variable with at least one sellable variation) and the document built from it. */
const unchangedPair: fc.Arbitrary<Pair> = fc.constantFrom(...CURRENCIES).chain(({ code, exp }) =>
  fc
    .record({
      name: fc.string({ minLength: 1, maxLength: 30 }),
      variable: fc.boolean(),
      simplePrice: exactPrice(exp),
      variations: fc.array(
        fc.record({
          status: fc.constantFrom('publish', 'private', 'draft'),
          price: fc.option(exactPrice(exp), { nil: undefined }),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      images: fc.array(
        fc.constantFrom(
          '',
          'https://shop.example/a.png',
          'https://shop.example/b.jpg',
          'http://localhost:8888/wp-content/uploads/c.webp',
        ),
        { maxLength: 4 },
      ),
      categories: fc.uniqueArray(fc.constantFrom(...CATEGORY_SLUGS), { maxLength: 5 }),
    })
    .filter(
      (p) =>
        !p.variable || p.variations.some((v) => v.status === 'publish' && v.price !== undefined),
    )
    .chain((p) =>
      fc
        .shuffledSubarray(p.categories, {
          minLength: p.categories.length,
          maxLength: p.categories.length,
        })
        .map((servedOrder): Pair => {
          const sellable = p.variable
            ? p.variations
                .filter((v) => v.status === 'publish' && v.price !== undefined)
                .map((v) => v.price!)
            : [p.simplePrice]
          const minors = sellable.map((s) => s.minor)
          const cheapest = sellable.reduce((a, b) => (b.minor < a.minor ? b : a))
          const product: Rec = {
            id: 501,
            name: p.name,
            slug: 'generated',
            type: p.variable ? 'variable' : 'simple',
            status: 'publish',
            price: p.variable ? cheapest.text : p.simplePrice.text,
            images: p.images.map((src, i) => ({ id: i + 1, src, alt: '' })),
            categories: p.categories.map((slug, i) => ({ id: i + 1, name: slug, slug })),
          }
          const variations: Rec[] = p.variable
            ? p.variations.map((v, i) => ({
                id: 600 + i,
                status: v.status,
                price: v.price?.text ?? '',
              }))
            : []
          return {
            currency: code,
            exp,
            source: { product, variations },
            served: {
              name: p.name,
              priceRange: { minMinor: Math.min(...minors), maxMinor: Math.max(...minors) },
              variantCount: sellable.length,
              media: p.images.filter((src) => src !== '').map((url) => ({ url })),
              categories: servedOrder.map((slug) => ({ slug })),
            },
          }
        }),
    ),
)

/** The served document with each field of `changed` made to differ from the source. */
function changedIn(served: Served, changed: ReadonlySet<Field>, by: number): Served {
  return {
    name: changed.has('name') ? `${served.name} (copy)` : served.name,
    priceRange: changed.has('price')
      ? { minMinor: served.priceRange.minMinor + by, maxMinor: served.priceRange.maxMinor + by }
      : served.priceRange,
    variantCount: changed.has('variants') ? served.variantCount + by : served.variantCount,
    media: changed.has('images')
      ? [...served.media, ...Array.from({ length: by }, (_, i) => ({ url: `/extra-${i}.png` }))]
      : served.media,
    categories: changed.has('categories')
      ? [...served.categories, { slug: FOREIGN_SLUG }]
      : served.categories,
  }
}

describe('diffProduct', () => {
  it('AC-1: for generated simple and variable products in GBP, JPY and KWD, an unchanged pair returns no change', () => {
    fc.assert(
      fc.property(unchangedPair, ({ source, served, currency }) => {
        expect(diffProduct(source, served, currency)).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: with a drawn subset of the five fields changed, exactly those fields are returned, in order, each with differing sides, and price shows the served range at the exponent', () => {
    fc.assert(
      fc.property(
        unchangedPair,
        fc.subarray([...FIELDS]),
        fc.integer({ min: 1, max: 999 }),
        ({ source, served, currency, exp }, fields, by) => {
          const changed = new Set(fields)
          const preview = changedIn(served, changed, by)

          const changes = diffProduct(source, preview, currency)

          expect(changes.map((c) => c.field)).toEqual(FIELDS.filter((f) => changed.has(f)))
          expect(changes.filter((c) => c.source === c.preview)).toEqual([])
          expect(changes.find((c) => c.field === 'price')?.preview).toBe(
            changed.has('price')
              ? shown(
                  atExponent(preview.priceRange.minMinor, exp),
                  atExponent(preview.priceRange.maxMinor, exp),
                )
              : undefined,
          )
        },
      ),
      { numRuns: 300 },
    )
  })

  it("AC-1: a simple price with digits past the exponent, served at its value rounded half up, is a price change keeping WooCommerce's own string", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 2 }),
        fc.integer({ min: 1, max: 9 }),
        ({ code, exp }, kept, middle, last) => {
          const excess = [...middle, last]
          const base = atExponent(kept, exp)
          const text = `${base}${exp === 0 ? '.' : ''}${excess.join('')}`
          const rounded = kept + (excess[0]! >= 5 ? 1 : 0)
          const source = {
            product: {
              id: 7,
              name: 'Sampler',
              type: 'simple',
              status: 'publish',
              price: text,
              images: [],
              categories: [],
            },
            variations: [],
          }
          const served: Served = {
            name: 'Sampler',
            priceRange: { minMinor: rounded, maxMinor: rounded },
            variantCount: 1,
            media: [],
            categories: [],
          }

          expect(diffProduct(source, served, code)).toEqual([
            { field: 'price', source: text, preview: atExponent(rounded, exp) },
          ])
        },
      ),
      { numRuns: 300 },
    )
  })

  const simple = (price: string): { product: Rec; variations: Rec[] } => ({
    product: {
      id: 26,
      name: 'Tea Sampler',
      type: 'simple',
      status: 'publish',
      price,
      images: [],
      categories: [{ id: 1, name: 'Kitchen', slug: 'kitchen' }],
    },
    variations: [],
  })
  const servedAt = (minor: number, variantCount = 1): Served => ({
    name: 'Tea Sampler',
    priceRange: { minMinor: minor, maxMinor: minor },
    variantCount,
    media: [],
    categories: [{ slug: 'kitchen' }],
  })

  it('AC-1: a GBP source of "4.995" served at 500 is a price change from "4.995" to "5.00"', () => {
    expect(diffProduct(simple('4.995'), servedAt(500), 'GBP')).toEqual([
      { field: 'price', source: '4.995', preview: '5.00' },
    ])
  })

  it('AC-1: a JPY source of "1500" served at 1500 and a GBP source of "12.0" served at 1200 are unchanged', () => {
    expect([
      diffProduct(simple('1500'), servedAt(1500), 'JPY'),
      diffProduct(simple('12.0'), servedAt(1200), 'GBP'),
    ]).toEqual([[], []])
  })

  it('AC-1: a private variation and a price-less one count in neither variants nor price when the served variants exclude them', () => {
    const source = {
      product: { ...simple('6.00').product, type: 'variable' },
      variations: [
        { id: 1, status: 'publish', price: '8.00' },
        { id: 2, status: 'publish', price: '6.00' },
        { id: 3, status: 'private', price: '4.00' },
        { id: 4, status: 'publish', price: '' },
        { id: 5, status: 'publish', price: '9.00' },
      ],
    }
    const served: Served = { ...servedAt(600, 3), priceRange: { minMinor: 600, maxMinor: 900 } }

    expect(diffProduct(source, served, 'GBP')).toEqual([])
    expect(
      diffProduct(source, { ...served, priceRange: { minMinor: 600, maxMinor: 950 } }, 'GBP'),
    ).toEqual([{ field: 'price', source: '6.00–9.00', preview: '6.00–9.50' }])
  })
})
