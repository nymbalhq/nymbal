export type ProductStatus = 'draft' | 'active' | 'archived'
export type ProductType = 'simple' | 'variable'
export type VariantStatus = 'active' | 'inactive'

export interface ProductMedia {
  url: string
  altText: string
  position: number
}

export interface VariantOption {
  name: string
  value: string
}

export interface VariantDimensions {
  lengthMm?: number
  widthMm?: number
  heightMm?: number
}

export interface Variant {
  id: string
  productId: string
  sku: string
  name: string
  priceMinor: number
  compareAtPriceMinor: number | null
  weightGrams: number | null
  dimensions: VariantDimensions | null
  stock: number
  lowStockThreshold: number
  options: VariantOption[]
  status: VariantStatus
  /** What a tax engine taxes the variant as, over its product's; null or absent for the product's. */
  taxCode?: string | null
  /** The variant's GTIN (UPC, EAN, ISBN-13), as `isGtin` takes it; null or absent for none. */
  gtin?: string | null
  createdAt: string
  updatedAt: string
}

export interface Product {
  id: string
  slug: string
  name: string
  description: string
  shortDescription: string
  status: ProductStatus
  type: ProductType
  seoTitle: string
  seoDescription: string
  media: ProductMedia[]
  metadata: Record<string, unknown>
  /** What a tax engine taxes the product's variants as; null or absent for the standard rate. */
  taxCode?: string | null
  /** The product's brand; empty or absent for none. */
  brand?: string
  createdAt: string
  updatedAt: string
}

/**
 * Whether `value` is a GTIN: 8, 12, 13 or 14 digits whose last is the GS1 check digit. The weights 3 and 1 alternate
 * from the digit before the check digit, so a code padded with leading zeros keeps its check digit.
 */
export function isGtin(value: string): boolean {
  if (!/^(?:\d{8}|\d{12,14})$/.test(value)) return false
  let sum = 0
  for (let i = value.length - 2, weight = 3; i >= 0; i -= 1, weight = 4 - weight) {
    sum += Number(value[i]) * weight
  }
  return (10 - (sum % 10)) % 10 === Number(value[value.length - 1])
}

/** The orders a product listing can be requested in; ties break by slug, ascending. */
export const PRODUCT_SORT_KEYS = [
  'newest',
  'price-asc',
  'price-desc',
  'name-asc',
  'name-desc',
] as const
export type ProductSortKey = (typeof PRODUCT_SORT_KEYS)[number]
export const DEFAULT_PRODUCT_SORT: ProductSortKey = 'newest'
/** What a storefront shows for each sort. */
export const PRODUCT_SORT_LABELS: Readonly<Record<ProductSortKey, string>> = {
  newest: 'Newest',
  'price-asc': 'Price: Low to High',
  'price-desc': 'Price: High to Low',
  'name-asc': 'Name: A to Z',
  'name-desc': 'Name: Z to A',
}
