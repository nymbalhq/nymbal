import { describe, expect, it } from 'vitest'
import { mapProduct, productWarnings } from '../../src/woocommerce/mappers/product.js'
import { storeContext, wcProduct, wcVariable, wcVariation } from './support/wc.js'

// What WooCommerce would not sell as Nymbal would: a grouped product (a page listing other products, priced at its
// cheapest child's price with no regular price of its own), an external product (a link to another shop) and a
// product with no price. Each imports as a draft whose variants cannot be bought. Stock here is counted and positive,
// so the only lossy mapping in each example is the one under test.

const counted = { manage_stock: true, stock_quantity: 5, stock_status: 'instock' } as const

function expectUnsellable(product: ReturnType<typeof mapProduct>): void {
  expect(product.status).toBe('draft')
  expect(product.variants!.length).toBeGreaterThanOrEqual(1)
  const inactive = product.variants!.filter((v) => v.status === 'inactive')
  expect(inactive.length).toBe(product.variants!.length)
}

describe('mapProduct, products WooCommerce would not sell as Nymbal would', () => {
  it('AC-7: a published grouped product imports as a draft with inactive variants, its children’s ids kept, and one warning', () => {
    const wc = wcProduct({
      ...counted,
      type: 'grouped',
      price: '7.60',
      regular_price: '',
      on_sale: true,
      grouped_products: [15, 16],
    })
    const ctx = storeContext()
    const product = mapProduct(wc, [], [], [], '', ctx)
    expectUnsellable(product)
    const woo = product.metadata!['woocommerce'] as Record<string, unknown>
    expect(woo['groupedProductIds']).toEqual([15, 16])
    expect(productWarnings(wc, [], ctx)).toHaveLength(1)
  })

  it('AC-7: a published external product imports as a draft with inactive variants, its URL kept, and one warning', () => {
    const wc = wcProduct({
      ...counted,
      type: 'external',
      price: '120.00',
      regular_price: '120.00',
      external_url: 'https://example.com/partner/lamp',
    })
    const ctx = storeContext()
    const product = mapProduct(wc, [], [], [], '', ctx)
    expectUnsellable(product)
    const woo = product.metadata!['woocommerce'] as Record<string, unknown>
    expect(woo['externalUrl']).toBe('https://example.com/partner/lamp')
    expect(productWarnings(wc, [], ctx)).toHaveLength(1)
  })

  it('AC-7: a published simple product with an empty price imports as a draft with inactive variants and one warning, not live at 0', () => {
    const wc = wcProduct({ ...counted, price: '', regular_price: '', sale_price: '' })
    const ctx = storeContext()
    expectUnsellable(mapProduct(wc, [], [], [], '', ctx))
    expect(productWarnings(wc, [], ctx)).toHaveLength(1)
  })

  it('AC-7: a price of "0" is a real free product: active, its variant active at 0, with no warning', () => {
    const wc = wcProduct({ ...counted, price: '0', regular_price: '0' })
    const ctx = storeContext()
    const product = mapProduct(wc, [], [], [], '', ctx)
    expect(product.status).toBe('active')
    expect(product.variants!.map((v) => [v.status, v.priceMinor])).toEqual([['active', 0]])
    expect(productWarnings(wc, [], ctx)).toEqual([])
  })

  it('AC-7: a variation with an empty price imports inactive with one warning naming its id, and its priced siblings and the product stay active', () => {
    const priced = wcVariation({
      id: 41,
      sku: 'J-S',
      price: '60.00',
      regular_price: '60.00',
      ...counted,
    })
    const unpriced = wcVariation({
      id: 42,
      sku: 'J-M',
      price: '',
      regular_price: '',
      attributes: [{ id: 1, name: 'Size', option: 'M' }],
      ...counted,
    })
    const parent = wcVariable([priced, unpriced])
    const ctx = storeContext()
    const product = mapProduct(parent, [priced, unpriced], [], [], '', ctx)
    expect(product.status).toBe('active')
    const status = new Map(product.variants!.map((v) => [v.sku, v.status]))
    expect([status.get('J-S'), status.get('J-M')]).toEqual(['active', 'inactive'])
    const warnings = productWarnings(parent, [priced, unpriced], ctx)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('42')
  })

  it('AC-7: a variable product none of whose variations has a price imports as a draft with every variant inactive', () => {
    const variations = [45, 46].map((id) =>
      wcVariation({
        id,
        sku: `W-${id}`,
        price: '',
        regular_price: '',
        attributes: [{ id: 1, name: 'Size', option: `S${id}` }],
        ...counted,
      }),
    )
    const product = mapProduct(wcVariable(variations), variations, [], [], '', storeContext())
    expect(product.status).toBe('draft')
    expect(product.variants!.map((v) => v.status)).toEqual(['inactive', 'inactive'])
  })

  it('AC-7: a published, priced simple product with counted stock is carried over exactly: active, and no warning', () => {
    const wc = wcProduct({ ...counted, price: '12.00', regular_price: '12.00' })
    const ctx = storeContext()
    const product = mapProduct(wc, [], [], [], '', ctx)
    expect([product.status, product.variants![0]!.status]).toEqual(['active', 'active'])
    expect(productWarnings(wc, [], ctx)).toEqual([])
  })
})
