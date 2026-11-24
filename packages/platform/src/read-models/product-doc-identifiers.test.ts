import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ProductSnapshot, Variant } from '@nymbalhq/types'
import { buildProductDoc } from './builders.js'

// The storefront's product document carries the product's brand and each variant's GTIN, so the templates' JSON-LD and
// both agent feeds, which read the document, can serve them. The live projection writes what this builder builds
// (product-projection.test.ts).

const CTX = { storeId: 'test-store', currency: 'GBP' }
const GTINS = ['96385074', '036000291452', '4006381333931', '9780306406157', '00012345600012']

function variantOf(i: number, gtin: string | null | undefined): Variant {
  return {
    id: `v${i}`,
    productId: 'p1',
    sku: `SKU-${i}`,
    name: `Size ${i}`,
    priceMinor: 1000 + i,
    compareAtPriceMinor: null,
    weightGrams: null,
    dimensions: null,
    stock: 3,
    lowStockThreshold: 1,
    options: [],
    status: 'active',
    ...(gtin !== undefined && { gtin }),
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
}

function snapshotOf(over: Partial<ProductSnapshot>): ProductSnapshot {
  return {
    id: 'p1',
    slug: 'p1',
    name: 'Tote',
    description: 'A tote.',
    shortDescription: '',
    status: 'active',
    type: 'simple',
    seoTitle: '',
    seoDescription: '',
    media: [],
    metadata: {},
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    variants: [],
    categoryIds: [],
    ...over,
  }
}

type Doc = Record<string, unknown> & { variants: Array<Record<string, unknown>> }

describe('the product document carries brand and each variant’s gtin', () => {
  it('AC-5: property: buildProductDoc answers the snapshot’s brand as it is, and each variant’s gtin by its id, null for a variant with none', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.array(fc.option(fc.constantFrom(...GTINS), { nil: null }), {
          minLength: 0,
          maxLength: 4,
        }),
        (brand, gtins) => {
          const variants = gtins.map((g, i) => variantOf(i, g))
          const doc = buildProductDoc(
            snapshotOf({ brand, variants }),
            new Map(),
            CTX,
          ) as unknown as Doc
          expect(doc['brand']).toBe(brand)
          expect(doc.variants.map((v) => [v['id'], v['gtin']])).toEqual(
            variants.map((v) => [v.id, v.gtin]),
          )
        },
      ),
    )
  })

  it('AC-5: a snapshot folded from an event that has no brand key, whose variants have no gtin key, gives brand "" and every gtin null', () => {
    const old = snapshotOf({
      variants: [variantOf(0, undefined), variantOf(1, undefined)],
    }) as unknown as Record<string, unknown>
    delete old['brand']

    const doc = buildProductDoc(old as unknown as ProductSnapshot, new Map(), CTX) as unknown as Doc

    expect([doc['brand'], doc.variants.map((v) => v['gtin'])]).toEqual(['', [null, null]])
  })
})
