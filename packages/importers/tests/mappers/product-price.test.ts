import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mapProduct, productWarnings } from '../../src/woocommerce/mappers/product.js'
import type { WcVariation } from '../../src/woocommerce/client.js'
import { decimal, storeContext, wcProduct, wcVariable, wcVariation } from './support/wc.js'

// WooCommerce answers `price` as the price it charges now, `regular_price` as the list price and `on_sale` when a sale
// is live; a scheduled sale keeps `price` at the regular price until it starts.

const DIGITS = { GBP: 2, JPY: 0 } as const
type Currency = keyof typeof DIGITS

/** One priced item's money as WooCommerce answers it, with the minor amounts it was written from. */
const pricing = fc
  .record({
    regular: fc.integer({ min: 1, max: 10_000_000 }),
    saleFraction: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
    live: fc.boolean(),
  })
  .map(({ regular, saleFraction, live }) => {
    const sale = saleFraction === null ? null : Math.floor(regular * saleFraction)
    const onSale = sale !== null && live
    return { regular, sale, onSale, charged: onSale ? sale : regular }
  })

type Pricing = typeof pricing extends fc.Arbitrary<infer T> ? T : never

function moneyFields(p: Pricing, currency: Currency) {
  const digits = DIGITS[currency]
  return {
    price: decimal(p.charged, digits),
    regular_price: decimal(p.regular, digits),
    sale_price: p.sale === null ? '' : decimal(p.sale, digits),
    on_sale: p.onSale,
    // A sale price that is not live is one scheduled to start later.
    date_on_sale_from: p.sale !== null && !p.onSale ? '2099-01-01T00:00:00' : null,
    date_on_sale_to: p.sale !== null && !p.onSale ? '2099-01-31T23:59:59' : null,
  }
}

const expectedCompareAt = (p: Pricing): number | null =>
  p.onSale && p.regular > p.charged ? p.regular : null

describe('mapProduct prices', () => {
  it('AC-2: property: a simple product charges WooCommerce’s active price, with the regular price as compare-at only while a sale lowers it', () => {
    fc.assert(
      fc.property(fc.constantFrom<Currency>('GBP', 'JPY'), pricing, (currency, p) => {
        const variant = mapProduct(
          wcProduct(moneyFields(p, currency)),
          [],
          [],
          [],
          '',
          storeContext({ currency }),
        ).variants![0]!
        expect(variant.priceMinor).toBe(p.charged)
        expect(variant.compareAtPriceMinor).toBe(expectedCompareAt(p))
      }),
      { numRuns: 400 },
    )
  })

  it('AC-2: property: each variation charges its own active price, with its own compare-at', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Currency>('GBP', 'JPY'),
        fc.array(pricing, { minLength: 1, maxLength: 5 }),
        (currency, prices) => {
          const variations: WcVariation[] = prices.map((p, i) =>
            wcVariation({
              id: 200 + i,
              sku: `V-${i}`,
              attributes: [{ id: 1, name: 'Size', option: `S${i}` }],
              ...moneyFields(p, currency),
            }),
          )
          const product = mapProduct(
            wcVariable(variations),
            variations,
            [],
            [],
            '',
            storeContext({ currency }),
          )
          const bySku = new Map(product.variants!.map((v) => [v.sku, v]))
          prices.forEach((p, i) => {
            const variant = bySku.get(`V-${i}`)!
            expect(variant.priceMinor, `V-${i}`).toBe(p.charged)
            expect(variant.compareAtPriceMinor, `V-${i}`).toBe(expectedCompareAt(p))
          })
        },
      ),
      { numRuns: 200 },
    )
  })

  it('AC-2: a live sale with an end date imports at its sale price, keeps its dates and warns once, naming the end date', () => {
    const wc = wcProduct({
      price: '7.60',
      regular_price: '9.50',
      sale_price: '7.60',
      on_sale: true,
      date_on_sale_from: '2020-11-01T00:00:00',
      date_on_sale_to: '2099-12-31T23:59:59',
    })
    const store = storeContext()
    const product = mapProduct(wc, [], [], [], '', store)
    const variant = product.variants![0]!
    expect(variant.priceMinor).toBe(760)
    expect(variant.compareAtPriceMinor).toBe(950)
    const woo = product.metadata!['woocommerce'] as Record<string, unknown>
    expect(woo['sale']).toEqual({ from: '2020-11-01T00:00:00', to: '2099-12-31T23:59:59' })
    const warnings = productWarnings(wc, [], store)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('2099-12-31')
  })

  it('AC-2: a sale scheduled to start later imports at the regular price with no compare-at, and warns once', () => {
    const wc = wcProduct({
      price: '85.00',
      regular_price: '85.00',
      sale_price: '70.00',
      on_sale: false,
      date_on_sale_from: '2099-01-01T00:00:00',
      date_on_sale_to: '2099-01-31T23:59:59',
    })
    const store = storeContext()
    const variant = mapProduct(wc, [], [], [], '', store).variants![0]!
    expect(variant.priceMinor).toBe(8500)
    expect(variant.compareAtPriceMinor).toBeNull()
    expect(productWarnings(wc, [], store)).toHaveLength(1)
  })

  it('AC-2: a sale with no dates imports at its sale price with no warning', () => {
    const wc = wcProduct({
      price: '15.00',
      regular_price: '20.00',
      sale_price: '15.00',
      on_sale: true,
    })
    const store = storeContext()
    const variant = mapProduct(wc, [], [], [], '', store).variants![0]!
    expect([variant.priceMinor, variant.compareAtPriceMinor]).toEqual([1500, 2000])
    expect(productWarnings(wc, [], store)).toEqual([])
  })
})
