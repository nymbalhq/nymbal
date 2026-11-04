import type { ProductCreateInput } from '@nymbalhq/platform'
import type { VariantDimensions } from '@nymbalhq/types'
import type { WcProduct, WcVariation } from '../client.js'
import { slugify } from './category.js'
import { toMinorUnits } from './money.js'
import { toGrams, toMillimetres, type DimensionUnit, type WeightUnit } from './units.js'

/** The WooCommerce store's currency, units and low-stock amount, and the stock an untracked item imports with. */
export interface StoreContext {
  currency: string
  weightUnit: WeightUnit
  dimensionUnit: DimensionUnit
  lowStockAmount: number
  untrackedStock: number
}

type Variant = NonNullable<ProductCreateInput['variants']>[number]

/** A product or a variation as an item for sale: the fields both answer with. */
type Sellable = WcProduct | WcVariation

/** What one product imports as, and what it could not carry over exactly. */
interface Reading {
  unsellable: string | null
  variants: Variant[]
  warnings: string[]
}

function wcStatusToNymbal(status: string): 'active' | 'draft' {
  return status === 'publish' ? 'active' : 'draft'
}

/** The slug the product is created with: the WooCommerce slug (or name) slugified, plus the run's suffix if any. */
export function productSlug(wc: WcProduct, slugSuffix: string): string {
  const base = slugify(wc.slug || wc.name)
  return slugSuffix ? `${base}-${slugSuffix}` : base
}

const day = (timestamp: string): string => timestamp.slice(0, 10)

/** Why WooCommerce would not sell this product as a Nymbal product would be sold, or null when it would. */
function unsellableReason(
  wc: WcProduct,
  variations: WcVariation[],
  store: StoreContext,
): string | null {
  if (wc.type === 'grouped') {
    return `grouped product listing products ${wc.grouped_products.join(', ')}: imported as a draft, since Nymbal has no grouped products`
  }
  if (wc.type === 'external') {
    return `external product sold at ${wc.external_url}: imported as a draft that cannot be bought`
  }
  if (wc.type === 'variable') {
    return variations.some((v) => toMinorUnits(v.price, store.currency) !== null)
      ? null
      : 'no variation has a price: imported as a draft that cannot be bought'
  }
  return toMinorUnits(wc.price, store.currency) === null
    ? 'no price: imported as a draft that cannot be bought'
    : null
}

/** A sale WooCommerce runs on its own schedule, which the import cannot carry over; null when there is none. */
function saleWarning(item: Sellable, label: string): string | null {
  if (item.on_sale && item.date_on_sale_to !== null) {
    return `${label}on sale until ${day(item.date_on_sale_to)}: imported at the sale price, which will not end by itself`
  }
  if (!item.on_sale && item.sale_price !== '') {
    const from = item.date_on_sale_from === null ? '' : ` from ${day(item.date_on_sale_from)}`
    return `${label}a sale at ${item.sale_price} is scheduled${from}: imported at the regular price, with no sale`
  }
  return null
}

/** Stock for an item WooCommerce counts on its own or leaves untracked. */
function ownStock(item: Sellable, store: StoreContext): number {
  if (item.manage_stock === true) return Math.max(0, item.stock_quantity ?? 0)
  return item.stock_status === 'outofstock' ? 0 : store.untrackedStock
}

function dimensions(
  own: WcProduct['dimensions'],
  parent: WcProduct['dimensions'],
  unit: DimensionUnit,
): VariantDimensions | null {
  const out: VariantDimensions = {}
  for (const side of ['length', 'width', 'height'] as const) {
    const mm = toMillimetres(own[side] || parent[side], unit)
    if (mm !== null) out[`${side}Mm`] = mm
  }
  return Object.keys(out).length > 0 ? out : null
}

/** A variant's fields from the item sold: price, compare-at, units and low-stock threshold, the parent's where it has none. */
function soldAs(item: Sellable, parent: WcProduct, store: StoreContext) {
  const price = toMinorUnits(item.price, store.currency)
  const regular = toMinorUnits(item.regular_price, store.currency) ?? 0
  return {
    priced: price !== null,
    priceMinor: price ?? 0,
    compareAtPriceMinor: item.on_sale && price !== null && regular > price ? regular : null,
    weightGrams: toGrams(item.weight || parent.weight, store.weightUnit),
    dimensions: dimensions(item.dimensions, parent.dimensions, store.dimensionUnit),
    lowStockThreshold: item.low_stock_amount ?? parent.low_stock_amount ?? store.lowStockAmount,
  }
}

function negativeStock(item: Sellable, label: string): string | null {
  const quantity = item.stock_quantity ?? 0
  return item.manage_stock === true && quantity < 0
    ? `${label}stock was ${quantity} (backorders owed): imported as 0`
    : null
}

function readSimple(
  wc: WcProduct,
  slug: string,
  store: StoreContext,
  unsellable: string | null,
): Reading {
  const stock = ownStock(wc, store)
  const warnings = [
    saleWarning(wc, ''),
    negativeStock(wc, ''),
    wc.manage_stock === false && stock > 0
      ? `stock not tracked in WooCommerce: imported as ${stock} in stock`
      : null,
  ].filter((w) => w !== null)
  const { priced: _priced, ...fields } = soldAs(wc, wc, store)
  return {
    unsellable,
    warnings,
    variants: [
      {
        sku: wc.sku || slug,
        name: wc.name,
        ...fields,
        stock,
        options: [],
        status: unsellable === null ? 'active' : 'inactive',
      },
    ],
  }
}

function readVariable(
  wc: WcProduct,
  variations: WcVariation[],
  slug: string,
  store: StoreContext,
  unsellable: string | null,
): Reading {
  const warnings: string[] = []
  // A pool the parent counts, shared by the published variations that sell from it, is split evenly with the
  // remainder to the lowest ids: giving each variation the whole pool would sell it once per variation.
  const pool = Math.max(0, wc.stock_quantity ?? 0)
  const sharers = variations
    .filter((v) => v.manage_stock === 'parent' && v.status === 'publish')
    .map((v) => v.id)
    .sort((a, b) => a - b)
  const share = (id: number): number => {
    const rank = sharers.indexOf(id)
    if (rank < 0) return 0
    return Math.floor(pool / sharers.length) + (rank < pool % sharers.length ? 1 : 0)
  }
  const untracked: number[] = []

  const variants = variations.map((v): Variant => {
    const label = `variation ${v.id}: `
    const { priced, ...fields } = soldAs(v, wc, store)
    const stock = v.manage_stock === 'parent' ? share(v.id) : ownStock(v, store)
    if (v.manage_stock === false && stock > 0) untracked.push(v.id)
    warnings.push(
      ...[
        saleWarning(v, label),
        // A product none of whose variations has a price gets one warning for the product instead.
        unsellable === null && !priced ? `${label}no price: imported inactive` : null,
        negativeStock(v, label),
      ].filter((w) => w !== null),
    )
    const optionName = v.attributes.map((a) => a.option).join(' / ')
    return {
      sku: variantSku(wc, v, slug),
      name: optionName || `Variant ${v.id}`,
      ...fields,
      stock,
      options: v.attributes.map((a) => ({ name: a.name, value: a.option })),
      // A variable product is unsellable only when no variation is priced, so `priced` covers it.
      status: v.status === 'publish' && priced ? 'active' : 'inactive',
    }
  })

  if (sharers.length > 0) {
    const split = sharers.map((id) => `${id}: ${share(id)}`).join(', ')
    warnings.push(
      `variations ${sharers.join(', ')} sell from one stock pool of ${wc.stock_quantity ?? 0}: imported split as ${split}`,
    )
  }
  if (untracked.length > 0) {
    warnings.push(
      `variations ${untracked.join(', ')}: stock not tracked in WooCommerce: imported as ${store.untrackedStock} in stock each`,
    )
  }
  return { unsellable, variants, warnings }
}

function variantSku(wc: WcProduct, v: WcVariation, slug: string): string {
  return v.sku || `${wc.sku || slug}-${v.id}`
}

function readProduct(
  wc: WcProduct,
  variations: WcVariation[],
  slug: string,
  store: StoreContext,
): Reading {
  const unsellable = unsellableReason(wc, variations, store)
  const reading =
    wc.type === 'variable'
      ? readVariable(wc, variations, slug, store, unsellable)
      : readSimple(wc, slug, store, unsellable)
  if (unsellable !== null) reading.warnings.unshift(unsellable)
  return reading
}

/** What the import of this product cannot carry over exactly, one line each, in the words the report prints. */
export function productWarnings(
  wc: WcProduct,
  variations: WcVariation[],
  store: StoreContext,
): string[] {
  return readProduct(wc, variations, productSlug(wc, ''), store).warnings
}

/** The `meta_data` entries a merchant set: a key starting with `_` is a plugin's own and stays behind. */
function publicMeta(entries: WcProduct['meta_data']): Record<string, unknown> {
  const values = new Map<string, unknown[]>()
  for (const { key, value } of entries) {
    if (key.startsWith('_')) continue
    const held = values.get(key)
    if (held === undefined) values.set(key, [value])
    else held.push(value)
  }
  return Object.fromEntries(
    [...values].map(([key, list]) => [key, list.length === 1 ? list[0] : list]),
  )
}

export function mapProduct(
  wc: WcProduct,
  variations: WcVariation[],
  categoryIds: string[],
  mediaUrls: Array<{ url: string; altText: string }>,
  slugSuffix: string,
  store: StoreContext,
): ProductCreateInput {
  const slug = productSlug(wc, slugSuffix)
  const status = wcStatusToNymbal(wc.status)
  const reading = readProduct(wc, variations, slug, store)

  const seoTitle = wc.yoast_head_json?.title ?? wc.name
  const seoDescription =
    wc.yoast_head_json?.description ?? wc.short_description?.replace(/<[^>]+>/g, '') ?? ''

  const media = mediaUrls.map((m, i) => ({ url: m.url, altText: m.altText, position: i }))

  // Nymbal has no field for most of these: they are kept as WooCommerce answered them.
  const metadata: Record<string, unknown> = {
    woocommerce: {
      id: wc.id,
      sku: wc.sku,
      syncedAt: new Date().toISOString(),
      virtual: wc.virtual,
      downloadable: wc.downloadable,
      type: wc.type,
      tags: wc.tags.map((t) => ({ name: t.name, slug: t.slug })),
      taxStatus: wc.tax_status,
      taxClass: wc.tax_class,
      shippingClass: wc.shipping_class,
      attributes: wc.attributes.map((a) => ({
        name: a.name,
        options: a.options,
        visible: a.visible,
        variation: a.variation,
      })),
      meta: publicMeta(wc.meta_data),
      ...((wc.date_on_sale_from ?? wc.date_on_sale_to) !== null && {
        sale: { from: wc.date_on_sale_from, to: wc.date_on_sale_to },
      }),
      ...(wc.type === 'grouped' && { groupedProductIds: wc.grouped_products }),
      ...(wc.type === 'external' && { externalUrl: wc.external_url }),
      // Which WooCommerce item each variant was made from, by SKU: an order line names the variation it bought.
      variants: Object.fromEntries(
        (wc.type === 'variable' ? variations : [wc]).map((item, i) => [
          reading.variants[i]!.sku,
          {
            id: item.id,
            taxClass: item.tax_class,
            shippingClass: item.shipping_class,
            manageStock: item.manage_stock,
          },
        ]),
      ),
    },
  }

  return {
    slug,
    name: wc.name,
    description: stripHtml(wc.description),
    shortDescription: stripHtml(wc.short_description),
    status: reading.unsellable === null ? status : 'draft',
    type: wc.type === 'variable' ? 'variable' : 'simple',
    seoTitle,
    seoDescription,
    media,
    metadata,
    categoryIds,
    variants: reading.variants,
  }
}

export function isThinContent(description: string): boolean {
  const text = description.replace(/<[^>]+>/g, '').trim()
  const wordCount = text.split(/\s+/).filter(Boolean).length
  return wordCount < 50
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}
