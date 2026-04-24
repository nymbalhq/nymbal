import type { ProductCreateInput } from '@nymbal/platform'
import type { WcProduct, WcVariation } from '../client.js'
import { slugify } from './category.js'

const PRICE_MINOR_FACTOR = 100

function parsePriceMinor(price: string): number {
  const n = parseFloat(price)
  return isNaN(n) ? 0 : Math.round(n * PRICE_MINOR_FACTOR)
}

function parseWeightGrams(weight: string): number | null {
  const n = parseFloat(weight)
  return isNaN(n) || n <= 0 ? null : Math.round(n * 1000)
}

function parseDimensions(d: { length: string; width: string; height: string }) {
  const l = parseFloat(d.length)
  const w = parseFloat(d.width)
  const h = parseFloat(d.height)
  if ([l, w, h].some(isNaN)) return null
  // WooCommerce dimensions are in cm; Nymbal stores in mm
  return { lengthMm: Math.round(l * 10), widthMm: Math.round(w * 10), heightMm: Math.round(h * 10) }
}

function wcStatusToNymbal(status: string): 'active' | 'draft' {
  return status === 'publish' ? 'active' : 'draft'
}

export function mapProduct(
  wc: WcProduct,
  variations: WcVariation[],
  categoryIds: string[],
  mediaUrls: Array<{ url: string; altText: string }>,
  slugSuffix: string,
): ProductCreateInput {
  const slug = slugSuffix ? `${slugify(wc.slug || wc.name)}-${slugSuffix}` : slugify(wc.slug || wc.name)

  const seoTitle = wc.yoast_head_json?.title ?? wc.name
  const seoDescription = wc.yoast_head_json?.description ?? wc.short_description?.replace(/<[^>]+>/g, '') ?? ''

  const media = mediaUrls.map((m, i) => ({ url: m.url, altText: m.altText, position: i }))

  const metadata: Record<string, unknown> = {
    woocommerce: {
      id: wc.id,
      sku: wc.sku,
      syncedAt: new Date().toISOString(),
      virtual: wc.virtual,
      downloadable: wc.downloadable,
    },
  }

  if (wc.type === 'variable' && variations.length > 0) {
    const mappedVariants = variations.map((v) => {
      const optionName = v.attributes.map((a) => a.option).join(' / ')
      return {
        sku: v.sku || `${wc.sku || slug}-${v.id}`,
        name: optionName || `Variant ${v.id}`,
        priceMinor: parsePriceMinor(v.regular_price),
        compareAtPriceMinor: v.sale_price ? parsePriceMinor(v.regular_price) : null,
        weightGrams: parseWeightGrams(v.weight),
        dimensions: parseDimensions(v.dimensions),
        stock: v.stock_quantity ?? 0,
        lowStockThreshold: 5,
        options: v.attributes.map((a) => ({ name: a.name, value: a.option })),
        status: (v.status === 'publish' ? 'active' : 'inactive') as 'active' | 'inactive',
      }
    })
    return {
      slug,
      name: wc.name,
      description: stripHtml(wc.description),
      shortDescription: stripHtml(wc.short_description),
      status: wcStatusToNymbal(wc.status),
      type: 'variable',
      seoTitle,
      seoDescription,
      media,
      metadata,
      categoryIds,
      variants: mappedVariants,
    }
  }

  return {
    slug,
    name: wc.name,
    description: stripHtml(wc.description),
    shortDescription: stripHtml(wc.short_description),
    status: wcStatusToNymbal(wc.status),
    type: 'simple',
    seoTitle,
    seoDescription,
    media,
    metadata,
    categoryIds,
    variants: [
      {
        sku: wc.sku || slug,
        name: wc.name,
        priceMinor: parsePriceMinor(wc.regular_price),
        compareAtPriceMinor: wc.sale_price ? parsePriceMinor(wc.regular_price) : null,
        weightGrams: parseWeightGrams(wc.weight),
        dimensions: parseDimensions(wc.dimensions),
        stock: 0,
        lowStockThreshold: 5,
        options: [],
        status: 'active' as const,
      },
    ],
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
