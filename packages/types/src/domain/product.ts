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
  createdAt: string
  updatedAt: string
}
