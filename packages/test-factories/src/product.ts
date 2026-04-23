import type {
  Product,
  ProductStatus,
  Variant,
  VariantStatus,
  Category,
} from '@nymbal/types'
import { nextId, isoDate, randInt } from './prng.js'

export function createProduct(overrides?: Partial<Product>): Product {
  const id = nextId()
  return {
    id,
    slug: `product-${id.slice(0, 8)}`,
    name: `Test Product ${id.slice(0, 6)}`,
    description: 'A test product description.',
    shortDescription: 'Short description.',
    status: 'active' as ProductStatus,
    type: 'simple',
    seoTitle: '',
    seoDescription: '',
    media: [],
    metadata: {},
    createdAt: isoDate(),
    updatedAt: isoDate(),
    ...overrides,
  }
}

export function createVariant(overrides?: Partial<Variant>): Variant {
  const id = nextId()
  return {
    id,
    productId: nextId(),
    sku: `SKU-${id.slice(0, 6).toUpperCase()}`,
    name: 'Default',
    priceMinor: randInt(500, 10000),
    compareAtPriceMinor: null,
    weightGrams: null,
    dimensions: null,
    stock: randInt(0, 100),
    lowStockThreshold: 5,
    options: [],
    status: 'active' as VariantStatus,
    createdAt: isoDate(),
    updatedAt: isoDate(),
    ...overrides,
  }
}

export function createCategory(overrides?: Partial<Category>): Category {
  const id = nextId()
  return {
    id,
    parentId: null,
    name: `Category ${id.slice(0, 6)}`,
    slug: `category-${id.slice(0, 6)}`,
    description: '',
    position: 0,
    createdAt: isoDate(),
    ...overrides,
  }
}
