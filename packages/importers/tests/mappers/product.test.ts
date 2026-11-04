import { describe, it, expect } from 'vitest'
import { mapProduct, isThinContent } from '../../src/woocommerce/mappers/product.js'
import type { WcProduct, WcVariation } from '../../src/woocommerce/client.js'
import { storeContext } from './support/wc.js'

function makeProduct(overrides: Partial<WcProduct> = {}): WcProduct {
  return {
    id: 1,
    name: 'Test Product',
    slug: 'test-product',
    type: 'simple',
    status: 'publish',
    description: 'A detailed product description with enough content for testing purposes here.',
    short_description: 'Short desc',
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
    weight: '0.5',
    dimensions: { length: '10', width: '10', height: '5' },
    ...overrides,
  }
}

describe('mapProduct', () => {
  it('maps a simple product correctly', () => {
    const result = mapProduct(makeProduct(), [], [], [], '', storeContext())
    expect(result.slug).toBe('test-product')
    expect(result.name).toBe('Test Product')
    expect(result.type).toBe('simple')
    expect(result.status).toBe('active')
    expect(result.variants).toHaveLength(1)
    const variant = result.variants![0]!
    expect(variant.priceMinor).toBe(1999)
    expect(variant.sku).toBe('TEST-001')
  })

  it('maps WC draft status to nymbal draft', () => {
    const result = mapProduct(makeProduct({ status: 'draft' }), [], [], [], '', storeContext())
    expect(result.status).toBe('draft')
  })

  it('maps WC private status to nymbal draft', () => {
    const result = mapProduct(makeProduct({ status: 'private' }), [], [], [], '', storeContext())
    expect(result.status).toBe('draft')
  })

  it('maps a variable product with variants', () => {
    const variations: WcVariation[] = [
      {
        id: 10,
        sku: 'P-S',
        price: '29.99',
        regular_price: '29.99',
        sale_price: '',
        on_sale: false,
        date_on_sale_from: null,
        date_on_sale_to: null,
        manage_stock: true,
        stock_quantity: 5,
        stock_status: 'instock',
        backorders: 'no',
        low_stock_amount: null,
        tax_status: 'taxable',
        tax_class: '',
        shipping_class: '',
        status: 'publish',
        attributes: [{ id: 1, name: 'Size', option: 'S' }],
        weight: '0.3',
        dimensions: { length: '10', width: '10', height: '2' },
      },
      {
        id: 11,
        sku: 'P-M',
        price: '29.99',
        regular_price: '29.99',
        sale_price: '',
        on_sale: false,
        date_on_sale_from: null,
        date_on_sale_to: null,
        manage_stock: true,
        stock_quantity: 8,
        stock_status: 'instock',
        backorders: 'no',
        low_stock_amount: null,
        tax_status: 'taxable',
        tax_class: '',
        shipping_class: '',
        status: 'publish',
        attributes: [{ id: 1, name: 'Size', option: 'M' }],
        weight: '0.3',
        dimensions: { length: '10', width: '10', height: '2' },
      },
    ]
    const result = mapProduct(
      makeProduct({
        type: 'variable',
        price: '29.99',
        regular_price: '',
        manage_stock: false,
        stock_quantity: null,
        variations: [10, 11],
      }),
      variations,
      [],
      [],
      '',
      storeContext(),
    )
    expect(result.type).toBe('variable')
    expect(result.variants).toHaveLength(2)
    expect(result.variants![0]!.sku).toBe('P-S')
    expect(result.variants![0]!.priceMinor).toBe(2999)
    expect(result.variants![0]!.options).toEqual([{ name: 'Size', value: 'S' }])
  })

  it('appends suffix to slug when duplicate', () => {
    const result = mapProduct(makeProduct(), [], [], [], '42', storeContext())
    expect(result.slug).toBe('test-product-42')
  })

  it('stores woocommerce metadata', () => {
    const result = mapProduct(makeProduct({ id: 99, sku: 'X99' }), [], [], [], '', storeContext())
    const meta = result.metadata?.['woocommerce'] as Record<string, unknown>
    expect(meta['id']).toBe(99)
    expect(meta['sku']).toBe('X99')
  })

  it('flags virtual products in metadata', () => {
    const result = mapProduct(makeProduct({ virtual: true }), [], [], [], '', storeContext())
    const meta = result.metadata?.['woocommerce'] as Record<string, unknown>
    expect(meta['virtual']).toBe(true)
  })

  it('uses Yoast SEO data when available', () => {
    const result = mapProduct(
      makeProduct({ yoast_head_json: { title: 'Yoast Title', description: 'Yoast Desc' } }),
      [],
      [],
      [],
      '',
      storeContext(),
    )
    expect(result.seoTitle).toBe('Yoast Title')
    expect(result.seoDescription).toBe('Yoast Desc')
  })

  it('strips HTML from description', () => {
    const result = mapProduct(
      makeProduct({ description: '<p>Hello <strong>world</strong></p>' }),
      [],
      [],
      [],
      '',
      storeContext(),
    )
    expect(result.description).toBe('Hello world')
  })

  it('attaches downloaded media with positions', () => {
    const media = [
      { url: '/imported-media/a.jpg', altText: 'Image A' },
      { url: '/imported-media/b.jpg', altText: 'Image B' },
    ]
    const result = mapProduct(makeProduct(), [], [], media, '', storeContext())
    expect(result.media).toHaveLength(2)
    expect(result.media![0]!.position).toBe(0)
    expect(result.media![1]!.position).toBe(1)
  })
})

describe('isThinContent', () => {
  it('returns true for empty description', () => {
    expect(isThinContent('')).toBe(true)
  })

  it('returns true for short description (< 50 words)', () => {
    expect(isThinContent('A shirt.')).toBe(true)
  })

  it('returns false for content with 50+ words', () => {
    const words = Array.from({ length: 55 }, (_, i) => `word${i}`).join(' ')
    expect(isThinContent(words)).toBe(false)
  })

  it('strips HTML before counting words', () => {
    const html = '<p>' + Array.from({ length: 10 }, () => 'word').join(' ') + '</p>'
    expect(isThinContent(html)).toBe(true)
  })
})
