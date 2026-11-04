import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WcProduct, WcVariation } from '../../../src/woocommerce/client.js'
import type { StoreContext } from '../../../src/woocommerce/mappers/product.js'

// WooCommerce products and variations as the REST API answers them (every field the mapper reads, set the way
// WooCommerce sets it for a plain, published, priced product with counted stock), the store context the mapper
// takes, and the recorded stores' payloads for tests that want real shapes.

export function wcProduct(overrides: Partial<WcProduct> = {}): WcProduct {
  const base: WcProduct = {
    id: 1,
    name: 'Test Product',
    slug: 'test-product',
    type: 'simple',
    status: 'publish',
    description: 'A product.',
    short_description: '',
    sku: 'TEST-001',
    price: '19.99',
    regular_price: '19.99',
    sale_price: '',
    on_sale: false,
    date_on_sale_from: null,
    date_on_sale_to: null,
    manage_stock: true,
    stock_quantity: 10,
    stock_status: 'instock',
    backorders: 'no',
    low_stock_amount: null,
    tags: [],
    tax_status: 'taxable',
    tax_class: '',
    shipping_class: '',
    grouped_products: [],
    external_url: '',
    categories: [],
    images: [],
    attributes: [],
    variations: [],
    meta_data: [],
    downloadable: false,
    virtual: false,
    weight: '',
    dimensions: { length: '', width: '', height: '' },
  }
  return { ...base, ...overrides }
}

export function wcVariation(overrides: Partial<WcVariation> = {}): WcVariation {
  const base: WcVariation = {
    id: 101,
    sku: 'TEST-001-V',
    price: '19.99',
    regular_price: '19.99',
    sale_price: '',
    on_sale: false,
    date_on_sale_from: null,
    date_on_sale_to: null,
    manage_stock: true,
    stock_quantity: 10,
    stock_status: 'instock',
    backorders: 'no',
    low_stock_amount: null,
    tax_status: 'taxable',
    tax_class: '',
    shipping_class: '',
    status: 'publish',
    attributes: [{ id: 1, name: 'Size', option: 'M' }],
    weight: '',
    dimensions: { length: '', width: '', height: '' },
  }
  return { ...base, ...overrides }
}

/** A variable product over `variations`, its `variations` ids and `price` (the cheapest variation's) set as WooCommerce sets them. */
export function wcVariable(
  variations: WcVariation[],
  overrides: Partial<WcProduct> = {},
): WcProduct {
  const prices = variations.map((v) => v.price).filter((p) => p !== '')
  const cheapest = prices.sort((a, b) => Number(a) - Number(b))[0] ?? ''
  return wcProduct({
    type: 'variable',
    sku: 'VAR',
    price: cheapest,
    regular_price: '',
    sale_price: '',
    on_sale: variations.some((v) => v.on_sale),
    manage_stock: false,
    stock_quantity: null,
    variations: variations.map((v) => v.id),
    ...overrides,
  })
}

export function storeContext(overrides: Partial<StoreContext> = {}): StoreContext {
  return {
    currency: 'GBP',
    weightUnit: 'kg',
    dimensionUnit: 'cm',
    lowStockAmount: 3,
    untrackedStock: 1000,
    ...overrides,
  }
}

/** A minor-unit amount written as WooCommerce writes a price in a currency with `digits` fraction digits. */
export function decimal(minor: number, digits: number): string {
  if (digits === 0) return String(minor)
  const text = String(minor).padStart(digits + 1, '0')
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`
}

const RECORDED = fileURLToPath(new URL('../../integration/fixtures/recorded', import.meta.url))

export interface RecordedCatalogue {
  currency: string
  weightUnit: string
  dimensionUnit: string
  lowStockAmount: number
  products: Array<{ product: WcProduct; variations: WcVariation[] }>
}

/** A recorded store's products, each with the variations WooCommerce answered for it, and the store's own settings. */
export function recordedCatalogue(store: 'store-a-gbp' | 'store-b-jpy'): RecordedCatalogue {
  const dir = join(RECORDED, store)
  const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const manifest = read('manifest.json') as { settings: Record<string, string> }
  const products = read('products.page-1.json') as WcProduct[]
  return {
    currency: manifest.settings['woocommerce_currency']!,
    weightUnit: manifest.settings['woocommerce_weight_unit']!,
    dimensionUnit: manifest.settings['woocommerce_dimension_unit']!,
    lowStockAmount: Number(manifest.settings['woocommerce_notify_low_stock_amount']),
    products: products.map((product) => {
      const file = `products-${product.id}-variations.json`
      const variations = existsSync(join(dir, file)) ? (read(file) as WcVariation[]) : []
      return { product, variations }
    }),
  }
}
