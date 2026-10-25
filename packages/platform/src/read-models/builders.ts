import type {
  Category,
  Customer,
  CustomerProfile,
  Logger,
  Order,
  OrderHistoryEntry,
  OrderStatus,
  OrderTimelineEntry,
  ProductSnapshot,
  SearchDocument,
  VariantOption,
} from '@nymbalhq/types'
import { orderTimeline } from './order-timeline.js'

// One pure builder per read-model document. The live projections and the rebuilders both call these, on the entity
// rows as the command store holds them, so a document has one definition and a rebuild equals what live delivery
// wrote.

export const CATEGORIES = 'categories'
export const PRODUCTS = 'products'
export const PRODUCTS_BY_CATEGORY = 'products-by-category'
export const ORDERS = 'orders'
export const ORDERS_BY_CUSTOMER = 'orders-by-customer'
export const CUSTOMER_PROFILES = 'customer-profiles'

/** A document of a collection, under its key. */
export interface DocumentWrite {
  collection: string
  key: string
  doc: unknown
}

export interface CategoryDoc {
  id: string
  storeId: string
  parentId: string | null
  slug: string
  name: string
  description: string
  position: number
  createdAt: string
}

export interface DenormalisedProduct {
  id: string
  storeId: string
  slug: string
  name: string
  description: string
  shortDescription: string
  status: string
  type: string
  media: unknown
  variantCount: number
  inStock: boolean
  priceRange: { minMinor: number; maxMinor: number } | null
  currency: string | null
  priceMinor: number | null
  variants: Array<{
    id: string
    sku: string
    name: string
    priceMinor: number
    stock: number
    options: VariantOption[]
  }>
  categoryIds: string[]
  categories: Array<{ id: string; name: string; slug: string }>
  createdAt: string
  updatedAt: string
  partitionKey?: string
  sortKey?: string
}

export interface OrderDoc extends Order {
  history: Array<{
    fromStatus: OrderStatus | null
    toStatus: OrderStatus
    actor: string
    note: string
    timestamp: string
  }>
  timeline: OrderTimelineEntry[]
  partitionKey?: string
  sortKey?: string
}

export interface ProductDocContext {
  storeId: string
  currency: string
  logger?: Logger
}

export function buildCategoryDoc(category: Category, storeId: string): CategoryDoc {
  return {
    id: category.id,
    storeId,
    parentId: category.parentId,
    slug: category.slug,
    name: category.name,
    description: category.description,
    position: category.position,
    createdAt: category.createdAt,
  }
}

const isVariantOption = (o: unknown): o is VariantOption =>
  typeof o === 'object' &&
  o !== null &&
  typeof (o as VariantOption).name === 'string' &&
  typeof (o as VariantOption).value === 'string'

/**
 * Older rows hold a variant's options as a JSON string; the read model always holds the array, so no storefront parses
 * them.
 */
function variantOptions(raw: unknown, sku: string, logger: Logger | undefined): VariantOption[] {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch (err) {
      logger?.warn({ sku, err }, 'variant options are not JSON; projected as none')
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.filter(isVariantOption).map((o) => ({ name: o.name, value: o.value }))
}

/** The product's document. A category id with no row in `categories` is left out of `categories`. */
export function buildProductDoc(
  p: ProductSnapshot,
  categories: ReadonlyMap<string, Category>,
  ctx: ProductDocContext,
): DenormalisedProduct {
  const prices = p.variants.map((v) => v.priceMinor)
  return {
    id: p.id,
    storeId: ctx.storeId,
    slug: p.slug,
    name: p.name,
    description: p.description,
    shortDescription: p.shortDescription,
    status: p.status,
    type: p.type,
    media: p.media,
    variantCount: p.variants.length,
    inStock: p.variants.some((v) => v.stock > 0),
    priceRange: prices.length
      ? { minMinor: Math.min(...prices), maxMinor: Math.max(...prices) }
      : null,
    currency: ctx.currency,
    priceMinor: prices[0] ?? null,
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      priceMinor: v.priceMinor,
      stock: v.stock,
      options: variantOptions(v.options, v.sku, ctx.logger),
    })),
    categoryIds: p.categoryIds,
    categories: p.categoryIds.flatMap((id) => {
      const c = categories.get(id)
      return c ? [{ id: c.id, name: c.name, slug: c.slug }] : []
    }),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

export const productByCategoryKey = (categorySlug: string, productSlug: string): string =>
  `category:${categorySlug}#product:${productSlug}`

/** The product's document and its entry under each of its categories. */
export function productWrites(doc: DenormalisedProduct): DocumentWrite[] {
  return [
    { collection: PRODUCTS, key: doc.slug, doc },
    ...doc.categories.map((c) => ({
      collection: PRODUCTS_BY_CATEGORY,
      key: productByCategoryKey(c.slug, doc.slug),
      doc: { ...doc, partitionKey: `category:${c.slug}`, sortKey: `product:${doc.slug}` },
    })),
  ]
}

/** Newest first within a customer: a descending timestamp prefix, then the order number. */
function customerSortKey(o: Order): string {
  return `order:${String(Number.MAX_SAFE_INTEGER - new Date(String(o.createdAt)).getTime()).padStart(16, '0')}:${o.orderNumber}`
}

export function buildOrderDoc(order: Order, history: OrderHistoryEntry[]): OrderDoc {
  const rows = history.map((h) => ({
    fromStatus: h.fromStatus,
    toStatus: h.toStatus,
    actor: h.actor,
    note: h.note,
    timestamp: String(h.timestamp),
  }))
  return { ...order, history: rows, timeline: orderTimeline(rows) }
}

/** The order's document, and its entry under its customer when it has one. */
export function orderWrites(doc: OrderDoc): DocumentWrite[] {
  const writes: DocumentWrite[] = [{ collection: ORDERS, key: doc.orderNumber, doc }]
  if (doc.customerId) {
    const sortKey = customerSortKey(doc)
    writes.push({
      collection: ORDERS_BY_CUSTOMER,
      key: `customer:${doc.customerId}#${sortKey}`,
      doc: { ...doc, partitionKey: `customer:${doc.customerId}`, sortKey },
    })
  }
  return writes
}

export function buildCustomerProfile(
  c: Pick<Customer, 'id' | 'orderCount' | 'totalSpentMinor' | 'createdAt'>,
): CustomerProfile {
  const { orderCount, totalSpentMinor } = c
  return {
    customerId: c.id,
    orderCount,
    totalSpentMinor,
    segment:
      totalSpentMinor > 100_000
        ? 'vip'
        : orderCount > 3
          ? 'returning'
          : orderCount > 0
            ? 'active'
            : 'new',
    createdAt: String(c.createdAt),
  }
}

const partitioned = (doc: unknown) => {
  const { partitionKey, sortKey } = doc as { partitionKey?: unknown; sortKey?: unknown }
  return `${String(partitionKey)}#${String(sortKey)}`
}

/** Each collection's key, as the writes above file a document under it. */
export const KEY_OF: Readonly<Record<string, (doc: unknown) => string>> = {
  [CATEGORIES]: (doc) => String((doc as CategoryDoc).slug),
  [PRODUCTS]: (doc) => String((doc as DenormalisedProduct).slug),
  [PRODUCTS_BY_CATEGORY]: partitioned,
  [ORDERS]: (doc) => String((doc as OrderDoc).orderNumber),
  [ORDERS_BY_CUSTOMER]: partitioned,
  [CUSTOMER_PROFILES]: (doc) => String((doc as CustomerProfile).customerId),
}

export function buildSearchDoc(p: ProductSnapshot): SearchDocument {
  return {
    id: p.id,
    type: 'product',
    fields: {
      slug: p.slug,
      name: p.name,
      description: p.description,
      status: p.status,
      categoryIds: p.categoryIds,
      variants: p.variants.map((v) => ({ sku: v.sku, name: v.name, priceMinor: v.priceMinor })),
    },
  }
}
