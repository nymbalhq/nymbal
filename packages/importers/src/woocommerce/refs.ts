import type { WcCategory, WcOrder, WcProduct, WcReview } from './client.js'

// What the import reads from a source record besides what its mapper reads. The importer and the plan both read
// through these, so the plan follows any change to what the import reads.

/** The images the import fetches: those with a `src`, in order. */
export function imageSources(
  images: ReadonlyArray<{ src: string; alt: string }>,
): Array<{ src: string; alt: string }> {
  const out: Array<{ src: string; alt: string }> = []
  for (const img of images) {
    if (!img.src) continue
    out.push({ src: img.src, alt: img.alt })
  }
  return out
}

export interface ProductRefs {
  /** The slug the import dedupes on before the mapper slugifies it. */
  rawSlug: string
  /** The WooCommerce id when an earlier product in this run had the same raw slug, else `''`. */
  slugSuffix: string
  isVariable: boolean
  /** The variation ids a variable product lists; 0 for any other type. */
  variationCount: number
  categoryWcIds: number[]
  imageSources: Array<{ src: string; alt: string }>
}

/** `seenSlugs` holds the raw slugs of the products read so far in this run; this product's is added. */
export function productRefs(wc: WcProduct, seenSlugs: Set<string>): ProductRefs {
  const rawSlug = wc.slug || wc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const slugSuffix = seenSlugs.has(rawSlug) ? String(wc.id) : ''
  seenSlugs.add(rawSlug)
  const isVariable = wc.type === 'variable'
  return {
    rawSlug,
    slugSuffix,
    isVariable,
    variationCount: isVariable ? wc.variations.length : 0,
    categoryWcIds: wc.categories.map((c) => c.id),
    imageSources: imageSources(wc.images),
  }
}

/** `parentWcId` is 0 for a top-level category. */
export function categoryRefs(wc: WcCategory): { parentWcId: number } {
  return { parentWcId: wc.parent }
}

/** `customerWcId` is 0 for a guest order. */
export function orderRefs(wc: WcOrder): { customerWcId: number; lineProductWcIds: number[] } {
  return {
    customerWcId: wc.customer_id,
    lineProductWcIds: wc.line_items.map((li) => li.product_id),
  }
}

export function reviewRefs(wc: WcReview): { productWcId: number } {
  return { productWcId: wc.product_id }
}
