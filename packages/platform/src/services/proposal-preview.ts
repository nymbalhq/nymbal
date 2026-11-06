import {
  NotFoundError,
  PREVIEWED_COMMANDS,
  type Order,
  type ProductSnapshot,
  type ProposalChange,
  type ProposalPreview,
  type ProposalView,
  type Variant,
} from '@nymbalhq/types'
import type { Repositories } from '../repositories/index.js'
import type { ProductService } from './product-service.js'

// What a pending write would change, read from the store as it is when the proposal is read, so an admin approves a
// change they can see (a price before and after) and not an id and a number.

/** The store's records a preview reads, each null when the id names nothing. */
export interface PreviewReads {
  /** The store's currency, for a product's prices. */
  currency: string
  /** A product by id, else by slug, as the admin's product read answers it. */
  product(idOrSlug: string): Promise<ProductSnapshot | null>
  variant(id: string): Promise<{ variant: Variant; productName: string } | null>
  /** An order by id, else by number. */
  order(idOrNumber: string): Promise<Order | null>
}

/** A product update's body fields, in the schema's order, with what the admin reads each as. */
const SCALARS = [
  ['name', 'Name'],
  ['description', 'Description'],
  ['shortDescription', 'Short description'],
  ['status', 'Status'],
  ['type', 'Type'],
  ['seoTitle', 'SEO title'],
  ['seoDescription', 'SEO description'],
] as const
const COLLECTIONS = [
  ['media', 'Media'],
  ['metadata', 'Metadata'],
  ['categoryIds', 'Categories'],
] as const

type Rec = Record<string, unknown>

const isRec = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const valueOf = (value: unknown): string | number | null =>
  typeof value === 'string' || typeof value === 'number' ? value : null
const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0)
const countOf = (value: unknown): number =>
  Array.isArray(value) ? value.length : isRec(value) ? Object.keys(value).length : 0

/** The value as JSON with every object's keys sorted, so two equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRec(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  )
}

function productChanges(product: ProductSnapshot, args: Rec): ProposalChange[] {
  const now = product as unknown as Rec
  const changes: ProposalChange[] = []
  for (const [key, label] of SCALARS) {
    if (!(key in args)) continue
    changes.push({ label, kind: 'value', current: valueOf(now[key]), proposed: valueOf(args[key]) })
  }
  for (const [key, label] of COLLECTIONS) {
    if (!(key in args)) continue
    changes.push({
      label,
      kind: 'collection',
      current: countOf(now[key]),
      proposed: countOf(args[key]),
      changed: canonical(now[key]) !== canonical(args[key]),
    })
  }
  const entries = Array.isArray(args['variants']) ? args['variants'].filter(isRec) : []
  for (const entry of entries) {
    const variant = product.variants.find((v) => v.id === entry['id'])
    if (variant === undefined) {
      changes.push({
        label: `Variant ${String(entry['id'])}`,
        kind: 'money',
        current: null,
        proposed: valueOf(entry['priceMinor']),
      })
      continue
    }
    changes.push({
      label: `Price of ${variant.name}`,
      kind: 'money',
      current: variant.priceMinor,
      proposed: valueOf(entry['priceMinor']),
    })
    if ('compareAtPriceMinor' in entry) {
      changes.push({
        label: `Compare-at price of ${variant.name}`,
        kind: 'money',
        current: variant.compareAtPriceMinor,
        proposed: valueOf(entry['compareAtPriceMinor']),
      })
    }
  }
  return changes
}

const missing = (currency: string): ProposalPreview => ({ target: null, changes: [], currency })

/**
 * The preview of a pending proposal of a previewed command, read from `reads` now; undefined for any other proposal.
 * A target the arguments name that does not exist answers `target: null` and no changes.
 */
export async function previewOf(
  view: ProposalView,
  reads: PreviewReads,
): Promise<ProposalPreview | undefined> {
  if (view.status !== 'pending' || !PREVIEWED_COMMANDS.includes(view.command)) return undefined
  const { args } = view
  const named = (key: string) => String(args[key] ?? '')
  if (view.command === 'product.update') {
    const product = await reads.product(named('id'))
    if (product === null) return missing(reads.currency)
    return {
      target: { kind: 'product', id: product.id, label: product.name },
      changes: productChanges(product, args),
      currency: reads.currency,
    }
  }
  if (view.command === 'inventory.adjust') {
    const found = await reads.variant(named('variantId'))
    if (found === null) return missing(reads.currency)
    const { variant, productName } = found
    return {
      target: {
        kind: 'variant',
        id: variant.id,
        label: `${productName}, ${variant.name} (${variant.sku})`,
      },
      changes: [
        {
          label: 'Stock',
          kind: 'value',
          current: variant.stock,
          proposed: variant.stock + numberOf(args['delta']),
        },
      ],
      currency: reads.currency,
    }
  }
  const order = await reads.order(named('id'))
  if (order === null) return missing(reads.currency)
  const target = { kind: 'order' as const, id: order.id, label: `#${order.orderNumber}` }
  const change: ProposalChange =
    view.command === 'order.refund'
      ? {
          label: 'Refunded',
          kind: 'money',
          current: order.refundedMinor,
          proposed: order.refundedMinor + numberOf(args['amountMinor']),
        }
      : { label: 'Status', kind: 'value', current: order.status, proposed: 'cancelled' }
  return { target, changes: [change], currency: order.currency }
}

async function orNull<T>(found: Promise<T>): Promise<T | null> {
  try {
    return await found
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }
}

/** The preview's reads over the store's own services and repositories. */
export function storePreviewReads(deps: {
  product: Pick<ProductService, 'getById' | 'getBySlug'>
  repos: Pick<Repositories, 'product' | 'variant' | 'order'>
  currency: string
}): PreviewReads {
  const { product, repos, currency } = deps
  return {
    currency,
    async product(idOrSlug) {
      return (
        (await orNull(product.getById(idOrSlug))) ?? (await orNull(product.getBySlug(idOrSlug)))
      )
    },
    variant: (id) =>
      repos.variant.store.read(async (tx) => {
        const variant = await repos.variant.findById(tx, id)
        if (variant === null) return null
        const owner = await repos.product.findById(tx, variant.productId)
        return { variant, productName: owner?.name ?? '' }
      }),
    order: (idOrNumber) =>
      repos.order.store.read(
        async (tx) =>
          (await repos.order.findById(tx, idOrNumber)) ??
          (await repos.order.findByOrderNumber(tx, idOrNumber)),
      ),
  }
}
