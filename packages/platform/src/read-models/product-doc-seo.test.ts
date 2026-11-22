import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ProductSnapshot } from '@nymbalhq/types'
import { buildProductDoc } from './builders.js'

// The storefront's product document carries the product's SEO title and description, so a template's head can read
// what an admin set or approved. The live projection writes what this builder builds (product-projection.test.ts).

const CTX = { storeId: 'test-store', currency: 'GBP' }

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

describe('AC-17: the product document carries seoTitle and seoDescription', () => {
  it('AC-17: property: buildProductDoc answers the snapshot’s seoTitle and seoDescription as they are', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.string({ maxLength: 200 }),
        (seoTitle, seoDescription) => {
          const doc = buildProductDoc(
            snapshotOf({ seoTitle, seoDescription }),
            new Map(),
            CTX,
          ) as unknown as Record<string, unknown>
          expect([doc['seoTitle'], doc['seoDescription']]).toEqual([seoTitle, seoDescription])
        },
      ),
    )
  })

  it('AC-17: a snapshot from before the fields existed (an old event replayed) gives both as empty strings', () => {
    const old = snapshotOf({}) as unknown as Record<string, unknown>
    delete old['seoTitle']
    delete old['seoDescription']

    const doc = buildProductDoc(
      old as unknown as ProductSnapshot,
      new Map(),
      CTX,
    ) as unknown as Record<string, unknown>

    expect([doc['seoTitle'], doc['seoDescription']]).toEqual(['', ''])
  })
})
