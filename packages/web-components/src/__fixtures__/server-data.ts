import fc from 'fast-check'

// The data a server hands an element as properties, generated for the server-property suites. Names carry a prefix
// so data from a property and data from a store can never be mistaken for each other.

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

/** The projection of `GET /api/cart`: the lines and their sums, never the token or the customer. */
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

// ─── The data the store elements take as attributes ──────────────────────────────

const prefixed = (prefix: string) => word.map((w) => `${prefix}${w}`)
const path = word.map((w) => `/${w}`)

/** `nymbal-breadcrumb items`: `[{ label, href? }]`. */
export const crumbs = (prefix: string) =>
  fc.array(fc.record({ label: prefixed(prefix), href: fc.option(path, { nil: undefined }) }), {
    maxLength: 4,
  })

/** `nymbal-image-gallery images`: `[{ url, alt }]`. */
export const images = (prefix: string, minLength = 0) =>
  fc.uniqueArray(
    fc.record({
      url: word.map((w) => `https://example.test/${prefix}${w}.jpg`),
      alt: prefixed(prefix),
    }),
    { minLength, maxLength: 4, selector: (i) => i.url },
  )

/** `nymbal-site-header links` and a footer column's links: `[{ label, href }]`. */
export const links = (prefix: string, minLength = 0) =>
  fc.uniqueArray(fc.record({ label: prefixed(prefix), href: path }), {
    minLength,
    maxLength: 4,
    selector: (l) => l.href,
  })

/** `nymbal-site-footer columns`: `[{ heading, links }]`. */
export const columns = (prefix: string, minLength = 0) =>
  fc.array(fc.record({ heading: prefixed(prefix), links: links(prefix) }), {
    minLength,
    maxLength: 3,
  })

/** `nymbal-category-nav categories`: the `Category` shape `GET /api/categories` serves. */
export const categories = (prefix: string, minLength = 0) =>
  fc.uniqueArray(
    fc.record({
      id: word.map((w) => `${prefix}cat-${w}`),
      parentId: fc.constant(null),
      name: prefixed(prefix),
      slug: prefixed(prefix),
      description: fc.constantFrom('', 'A category'),
      position: fc.nat({ max: 9 }),
      createdAt: fc.constant('2026-10-22T00:00:00.000Z'),
    }),
    { minLength, maxLength: 4, selector: (c) => c.slug },
  )

/** `nymbal-review-list reviews`: approved reviews as `GET /api/products/:id/reviews` serves them. */
export const reviews = (prefix: string) =>
  fc.uniqueArray(
    fc.record({
      id: word.map((w) => `${prefix}rev-${w}`),
      productId: fc.constant(`${prefix}p1`),
      customerId: fc.constant(null),
      orderId: fc.constant(null),
      rating: fc.integer({ min: 1, max: 5 }),
      title: prefixed(prefix),
      body: word,
      moderationStatus: fc.constant('approved'),
      submittedAt: fc.constant('2026-10-22T00:00:00.000Z'),
      moderatedAt: fc.constant(null),
      moderatedBy: fc.constant(null),
    }),
    { maxLength: 4, selector: (r) => r.id },
  )

export interface SummaryLine {
  name: string
  qty: number
  unitPriceMinor: number
  lineTotalMinor: number
}

/** `nymbal-order-summary items`: `[{ name, qty, unitPriceMinor, lineTotalMinor }]`, each line's total qty × unit. */
export const summaryLines = (prefix: string, minLength = 0) =>
  fc
    .array(
      fc.record({
        name: prefixed(prefix),
        qty: fc.integer({ min: 1, max: 9 }),
        unitPriceMinor: money,
      }),
      { minLength, maxLength: 4 },
    )
    .map((lines): SummaryLine[] =>
      lines.map((l) => ({ ...l, lineTotalMinor: l.qty * l.unitPriceMinor })),
    )

export interface PdpVariant {
  id: string
  sku: string
  name: string
  priceMinor: number
  stock: number
  options: Array<{ name: string; value: string }>
}

/** A product whose variants carry their own price and stock (negatives included), as the product store holds it. */
export const pdpProduct = (prefix: string) =>
  fc
    .tuple(
      word.map((w) => `${prefix}prod-${w}`),
      fc.array(fc.record({ priceMinor: money, stock: fc.integer({ min: -5, max: 20 }) }), {
        minLength: 1,
        maxLength: 4,
      }),
    )
    .map(([id, rows]) => {
      const variants: PdpVariant[] = rows.map((r, i) => ({
        id: `${id}-v${i}`,
        sku: `${id}-SKU-${i}`,
        name: `Variant ${i}`,
        priceMinor: r.priceMinor,
        stock: r.stock,
        options: [{ name: 'Size', value: `S${i}` }],
      }))
      return {
        id,
        slug: id,
        name: 'Product',
        description: '',
        shortDescription: '',
        status: 'active',
        type: 'variable',
        media: [],
        variantCount: variants.length,
        inStock: variants.some((v) => v.stock > 0),
        priceRange: null,
        currency: 'GBP',
        priceMinor: variants[0]!.priceMinor,
        variants,
      }
    })

/** Money as the storefronts show it (`en-GB`), written out here as the suites' oracle. */
export function formatMoney(minor: number, currency = 'GBP'): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)
}
