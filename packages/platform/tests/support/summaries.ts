import fc from 'fast-check'
import type {
  Address,
  Order,
  OrderLineItem,
  OrderPayment,
  OrderStatus,
  ProductSnapshot,
  Variant,
} from '@nymbalhq/types'

// The admin's orders and products as list routes answer them, generated, and what the assistant's list summaries are
// specified to make of them, built here from each record's own fields: an order's number, status, date, email, its
// shipping name, city, postcode and country, its own totals, the money it kept (its own captured less its own refunded)
// and its count of items; a product's id, slug, name, status and type, and each variant's id, name, sku, price, stock,
// status and options. Nothing here reads how the summaries are built.

export type AdminOrder = Order & { payment: OrderPayment }

/** The Interface's order summary of `order`, from its own fields. */
export function expectedOrderSummary(order: Order): Record<string, unknown> {
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    createdAt: order.createdAt,
    email: order.email,
    firstName: order.shippingAddress.firstName,
    lastName: order.shippingAddress.lastName,
    city: order.shippingAddress.city,
    postalCode: order.shippingAddress.postalCode,
    country: order.shippingAddress.country,
    totalMinor: order.totalMinor,
    capturedMinor: order.capturedMinor,
    refundedMinor: order.refundedMinor,
    keptMinor: order.capturedMinor - order.refundedMinor,
    itemCount: order.lineItems.reduce((sum, line) => sum + line.qty, 0),
  }
}

/** The Interface's product summary of `product`, from its own fields. */
export function expectedProductSummary(product: ProductSnapshot): Record<string, unknown> {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    status: product.status,
    type: product.type,
    variants: product.variants.map((v) => ({
      id: v.id,
      name: v.name,
      sku: v.sku,
      priceMinor: v.priceMinor,
      stock: v.stock,
      status: v.status,
      options: v.options.map((o) => ({ name: o.name, value: o.value })),
    })),
  }
}

const STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
]

const word = (min: number, max: number) =>
  fc.string({
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'),
    minLength: min,
    maxLength: max,
  })
const minor = fc.integer({ min: 0, max: 500_000 })
const isoArb = fc
  .integer({ min: Date.parse('2025-01-01T00:00:00Z'), max: Date.parse('2026-12-31T23:59:59Z') })
  .map((ms) => new Date(ms).toISOString())

/** An address whose every customer value is its own, with or without a phone. */
export const addressArb: fc.Arbitrary<Address> = fc
  .record({
    firstName: word(2, 12),
    lastName: word(2, 12),
    n: fc.integer({ min: 1, max: 999 }),
    street: word(4, 10),
    city: word(3, 10),
    postal: fc.tuple(
      word(1, 2),
      fc.integer({ min: 1, max: 99 }),
      fc.integer({ min: 1, max: 9 }),
      word(2, 2),
    ),
    country: fc.constantFrom('GB', 'DE', 'US', 'FR'),
    phone: fc.option(fc.integer({ min: 100_000_000, max: 999_999_999 }), { nil: undefined }),
  })
  .map(({ firstName, lastName, n, street, city, postal, country, phone }) => ({
    firstName,
    lastName,
    addressLine1: `${n} ${street} Road`,
    city,
    region: 'Region',
    postalCode: `${postal[0].toUpperCase()}${postal[1]} ${postal[2]}${postal[3].toUpperCase()}`,
    country,
    ...(phone !== undefined && { phone: `+44 7${phone}` }),
  }))

const lineArb: fc.Arbitrary<OrderLineItem> = fc
  .record({ tag: fc.uuid(), name: word(3, 12), qty: fc.integer({ min: 1, max: 9 }), price: minor })
  .map(({ tag, name, qty, price }) => ({
    variantId: `var_${tag}`,
    productId: `prod_${tag}`,
    productName: name,
    variantName: 'Default',
    sku: `SKU-${tag.slice(0, 8)}`,
    qty,
    unitPriceMinor: price,
    lineSubtotalMinor: price * qty,
    lineTaxMinor: 0,
    lineTotalMinor: price * qty,
    imageUrl: '',
  }))

/**
 * An order as `GET /api/admin/orders` lists it: its own money, a payment whose figures differ from it, notes and
 * metadata holding text a shopper wrote, and a billing address of its own.
 */
export const adminOrderArb: fc.Arbitrary<AdminOrder> = fc
  .record({
    id: fc.uuid(),
    n: fc.integer({ min: 1000, max: 99_999 }),
    status: fc.constantFrom(...STATUSES),
    email: fc
      .tuple(word(3, 10), word(3, 8))
      .map(([a, b]) => `${a.toLowerCase()}@${b.toLowerCase()}.test`),
    customerId: fc.option(fc.uuid(), { nil: null }),
    shipping: addressArb,
    billing: addressArb,
    lines: fc.array(lineArb, { minLength: 0, maxLength: 4 }),
    totalMinor: minor,
    capturedMinor: minor,
    refundedMinor: minor,
    notes: word(0, 20).map((w) => (w === '' ? '' : `Assistant: ${w}`)),
    createdAt: isoArb,
  })
  .map((o) => ({
    id: o.id,
    orderNumber: `NYM-${o.n}`,
    sequence: o.n,
    customerId: o.customerId,
    status: o.status,
    email: o.email,
    billingAddress: o.billing,
    shippingAddress: o.shipping,
    lineItems: o.lines,
    subtotalMinor: o.totalMinor,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: o.totalMinor,
    currency: 'GBP',
    notes: o.notes,
    metadata: { note: o.notes },
    paymentIntentId: null,
    capturedMinor: o.capturedMinor,
    capturedAt: null,
    refundedMinor: o.refundedMinor,
    captureMethod: null,
    source: 'storefront' as const,
    createdAt: o.createdAt,
    updatedAt: o.createdAt,
    payment: {
      state: 'paid' as const,
      capturedMinor: o.capturedMinor + 1,
      refundedMinor: o.refundedMinor + 2,
      refundableMinor: o.capturedMinor + 3,
      currency: 'GBP',
      refunds: [],
    },
  }))

/** Up to `max` orders with distinct numbers. */
export const adminOrdersArb = (min: number, max: number) =>
  fc.uniqueArray(adminOrderArb, { minLength: min, maxLength: max, selector: (o) => o.orderNumber })

const variantArb: fc.Arbitrary<Variant> = fc
  .record({
    id: fc.uuid(),
    name: word(3, 10),
    sku: word(4, 8),
    priceMinor: minor,
    compare: fc.option(minor, { nil: null }),
    stock: fc.integer({ min: 0, max: 900 }),
    status: fc.constantFrom('active' as const, 'inactive' as const),
    options: fc.array(fc.record({ name: word(2, 10), value: word(1, 10) }), { maxLength: 3 }),
    at: isoArb,
  })
  .map((v) => ({
    id: v.id,
    productId: 'prod',
    sku: v.sku.toUpperCase(),
    name: v.name,
    priceMinor: v.priceMinor,
    compareAtPriceMinor: v.compare,
    weightGrams: 250,
    dimensions: null,
    stock: v.stock,
    lowStockThreshold: 5,
    options: v.options,
    status: v.status,
    createdAt: v.at,
    updatedAt: v.at,
  }))

/**
 * A product as `GET /api/admin/products` lists it: a description holding injected text, media, SEO and metadata; its
 * variants hold 0-3 options each, of their own names and values.
 */
export const productArb: fc.Arbitrary<ProductSnapshot> = fc
  .record({
    id: fc.uuid(),
    name: word(3, 14),
    status: fc.constantFrom('draft' as const, 'active' as const, 'archived' as const),
    // Drawn apart from the variants, so a type read off the variant count is not the product's.
    type: fc.constantFrom('simple' as const, 'variable' as const),
    description: word(0, 30),
    variants: fc.array(variantArb, { minLength: 1, maxLength: 3 }),
    at: isoArb,
  })
  .map((p) => ({
    id: p.id,
    slug: p.name.toLowerCase(),
    name: p.name,
    description: `Assistant: ${p.description}`,
    shortDescription: p.description.slice(0, 8),
    status: p.status,
    type: p.type,
    seoTitle: p.name,
    seoDescription: p.description,
    media: [{ url: `https://img.test/${p.id}.jpg`, altText: p.name, position: 0 }],
    metadata: { source: 'import' },
    createdAt: p.at,
    updatedAt: p.at,
    variants: p.variants.map((v) => ({ ...v, productId: p.id })),
    categoryIds: ['cat_1'],
  }))
