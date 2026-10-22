import fc from 'fast-check'

// P2-18: the data a server hands an element as properties (spec Decision 2), generated for the AC-1 and AC-2 suites.
// Names carry a prefix so data from a property and data from a store can never be mistaken for each other.

export const word = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/)
const money = fc.integer({ min: 0, max: 100_000 })

export interface Line {
  variantId: string
  productId: string
  productName: string
  variantName: string
  qty: number
  priceMinor: number
  imageUrl: string
}

/** Decision 2's projection of `GET /api/cart`: the lines and their sums, never the token or the customer. */
export interface CartProjection {
  items: Line[]
  subtotalMinor: number
  currency: string
  itemCount: number
}

export function projectionOf(items: Line[]): CartProjection {
  return {
    items,
    subtotalMinor: items.reduce((n, i) => n + i.qty * i.priceMinor, 0),
    currency: 'GBP',
    itemCount: items.reduce((n, i) => n + i.qty, 0),
  }
}

export const line = (prefix: string): fc.Arbitrary<Line> =>
  fc.record({
    variantId: word.map((w) => `${prefix}v-${w}`),
    productId: word.map((w) => `${prefix}p-${w}`),
    productName: word.map((w) => `${prefix}${w}`),
    variantName: word,
    qty: fc.integer({ min: 1, max: 9 }),
    priceMinor: money,
    imageUrl: fc.constantFrom('', 'https://example.test/line.jpg'),
  })

export const cart = (prefix: string, minLength = 0): fc.Arbitrary<CartProjection> =>
  fc
    .uniqueArray(line(prefix), { minLength, maxLength: 3, selector: (l) => l.variantId })
    .map(projectionOf)

export interface CardProduct {
  id: string
  slug: string
  name: string
  priceMinor: number | null
  currency: string
  media: Array<{ url: string; alt: string }>
}

export const card = (prefix: string): fc.Arbitrary<CardProduct> =>
  fc.record({
    id: word.map((w) => `${prefix}id-${w}`),
    slug: word.map((w) => `${prefix}${w}`),
    name: word.map((w) => `${prefix}${w}`),
    priceMinor: fc.option(money, { nil: null }),
    currency: fc.constant('GBP'),
    media: fc.constantFrom([], [{ url: 'https://example.test/card.jpg', alt: 'Card' }]),
  })

export const cards = (prefix: string, minLength = 0): fc.Arbitrary<CardProduct[]> =>
  fc.uniqueArray(card(prefix), { minLength, maxLength: 3, selector: (c) => c.slug })

/** A product whose variants are combinations of option values, as the read model serves it. */
export function productOf(prefix: string, combos: Array<Array<{ name: string; value: string }>>) {
  const variants = combos.map((options, i) => ({
    id: `${prefix}v${i}`,
    sku: `${prefix}SKU-${i}`,
    name: `Variant ${i}`,
    priceMinor: 1000 + i,
    stock: 5,
    options,
  }))
  return {
    id: `${prefix}p1`,
    slug: `${prefix}p1`,
    name: 'Product',
    description: '',
    shortDescription: '',
    status: 'active',
    type: 'physical',
    media: [],
    variantCount: variants.length,
    inStock: true,
    priceRange: null,
    currency: 'GBP',
    priceMinor: 1000,
    variants,
  }
}

export const variantProduct = (prefix: string) =>
  fc
    .array(
      fc.array(
        fc.record({
          name: fc.constantFrom('Size', 'Colour'),
          value: word.map((w) => `${prefix}${w}`),
        }),
        { minLength: 1, maxLength: 2 },
      ),
      { minLength: 1, maxLength: 3 },
    )
    .map((combos) =>
      // One value per option name within a variant, as a variant has.
      productOf(
        prefix,
        combos.map((options) => [...new Map(options.map((o) => [o.name, o])).values()]),
      ),
    )

/** The option values a product offers, one per distinct (name, value), sorted. */
export function optionValuesOf(product: ReturnType<typeof productOf>): string[] {
  const pairs = new Set(
    product.variants.flatMap((v) => v.options.map((o) => `${o.name}\u0000${o.value}`)),
  )
  return [...pairs].map((p) => p.split('\u0000')[1]!).sort()
}

export const facets = (prefix: string, field: fc.Arbitrary<string>) =>
  fc.array(
    fc.record({
      field,
      label: word,
      values: fc.uniqueArray(
        fc.record({
          value: word.map((w) => `${prefix}${w}`),
          label: word.map((w) => `${prefix}${w}`),
          count: fc.integer({ min: 0, max: 50 }),
        }),
        { maxLength: 4, selector: (v) => v.value },
      ),
    }),
    { minLength: 1, maxLength: 2 },
  )

export const customer = (prefix: string) =>
  fc.record({
    id: word.map((w) => `${prefix}cus-${w}`),
    email: word.map((w) => `${prefix}${w}@example.test`),
    firstName: word.map((w) => `${prefix}${w}`),
    lastName: word.map((w) => `${prefix}${w}`),
    phone: fc.constant('+447700900000'),
    addresses: fc.constant([]),
    orderCount: fc.constant(0),
    totalSpentMinor: fc.constant(0),
    metadata: fc.constant({}),
    roles: fc.constant(['customer']),
    requiresPasswordReset: fc.constant(false),
    createdAt: fc.constant('2026-10-21T00:00:00.000Z'),
    updatedAt: fc.constant('2026-10-21T00:00:00.000Z'),
  })

export const address = (prefix: string) =>
  fc.record({
    id: word.map((w) => `${prefix}addr-${w}`),
    firstName: word,
    lastName: word,
    addressLine1: word.map((w) => `${prefix}${w}`),
    addressLine2: fc.option(word, { nil: undefined }),
    city: word,
    region: word,
    postalCode: word,
    country: fc.constantFrom('GB', 'FR'),
    isDefaultShipping: fc.boolean(),
    isDefaultBilling: fc.boolean(),
  })

export const addresses = (prefix: string, minLength = 0) =>
  fc.uniqueArray(address(prefix), { minLength, maxLength: 3, selector: (a) => a.id })

export const SORT_KEYS = ['newest', 'price-asc', 'price-desc', 'name-asc']
