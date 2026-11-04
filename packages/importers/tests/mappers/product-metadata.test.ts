import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mapProduct } from '../../src/woocommerce/mappers/product.js'
import type { StoreContext } from '../../src/woocommerce/mappers/product.js'
import { recordedCatalogue, storeContext, wcProduct } from './support/wc.js'

// Nymbal has no field for tags, tax status and class, shipping class or product attributes: the import keeps them in
// `metadata.woocommerce` exactly as WooCommerce answered them. The recorded stores' payloads are the inputs.

type Woo = Record<string, unknown>

describe('mapProduct metadata, over the recorded stores', () => {
  for (const name of ['store-a-gbp', 'store-b-jpy'] as const) {
    it(`AC-6: ${name}: every product keeps its tags, tax status and class, shipping class and attributes with their flags, and each variation its classes under variants[sku]`, () => {
      const catalogue = recordedCatalogue(name)
      const ctx = storeContext({
        currency: catalogue.currency,
        weightUnit: catalogue.weightUnit as StoreContext['weightUnit'],
        dimensionUnit: catalogue.dimensionUnit as StoreContext['dimensionUnit'],
        lowStockAmount: catalogue.lowStockAmount,
      })
      for (const { product: wc, variations } of catalogue.products) {
        const woo = mapProduct(wc, variations, [], [], '', ctx).metadata!['woocommerce'] as Woo
        const label = `${name} ${wc.sku}`
        expect(woo['type'], label).toBe(wc.type)
        expect(woo['tags'], label).toEqual(wc.tags.map((t) => ({ name: t.name, slug: t.slug })))
        expect([woo['taxStatus'], woo['taxClass'], woo['shippingClass']], label).toEqual([
          wc.tax_status,
          wc.tax_class,
          wc.shipping_class,
        ])
        expect(woo['attributes'], label).toEqual(
          wc.attributes.map((a) => ({
            name: a.name,
            options: a.options,
            visible: a.visible,
            variation: a.variation,
          })),
        )
        const variants = woo['variants'] as Record<string, unknown>
        for (const v of variations) {
          expect(variants[v.sku], `${label} ${v.sku}`).toEqual({
            id: v.id,
            taxClass: v.tax_class,
            shippingClass: v.shipping_class,
            manageStock: v.manage_stock,
          })
        }
      }
    })
  }
})

describe('mapProduct public custom fields', () => {
  it('AC-8: property: every meta_data key not starting with "_" is kept under meta, a repeated key as its values in order, and no "_" key is kept', () => {
    const entry = fc.record({
      key: fc.constantFrom(
        'care',
        'season',
        'origin',
        '_supplier_ref',
        '_internal_cost',
        '_edit_lock',
      ),
      value: fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean()),
    })
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 8 }), (entries) => {
        const wc = wcProduct({
          meta_data: entries.map((e) => ({ key: e.key, value: e.value })),
        })
        const woo = mapProduct(wc, [], [], [], '', storeContext()).metadata!['woocommerce'] as Woo
        const expected: Record<string, unknown> = {}
        for (const key of new Set(entries.map((e) => e.key))) {
          if (key.startsWith('_')) continue
          const values = entries.filter((e) => e.key === key).map((e) => e.value)
          expected[key] = values.length === 1 ? values[0] : values
        }
        expect(woo['meta']).toEqual(expected)
      }),
      { numRuns: 300 },
    )
  })

  it('AC-8: the recorded tote keeps care_instructions and both seasons, and not its supplier reference', () => {
    const tote = recordedCatalogue('store-a-gbp').products.find((p) => p.product.sku === 'TOTE-01')!
    const woo = mapProduct(tote.product, [], [], [], '', storeContext()).metadata![
      'woocommerce'
    ] as Woo
    expect(woo['meta']).toEqual({
      care_instructions: 'Hand wash cold',
      season: ['spring', 'summer'],
    })
  })
})
