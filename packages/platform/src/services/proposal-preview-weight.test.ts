import { describe, expect, it } from 'vitest'
import type { ProductSnapshot, ProposalChange, ProposalView, Variant } from '@nymbalhq/types'
import { previewOf, type PreviewReads } from './proposal-preview.js'

// An agent's product update that changes what a variant weighs changes what its parcel costs to ship: the admin who
// approves it from its card sees the weight now beside the proposed one, not the prices alone.

function variantOf(over: Partial<Variant> = {}): Variant {
  return {
    id: 'var_large',
    productId: 'prod_tee',
    sku: 'TEE-L',
    name: 'Large',
    priceMinor: 2500,
    compareAtPriceMinor: 3000,
    weightGrams: 420,
    dimensions: null,
    stock: 7,
    lowStockThreshold: 2,
    options: [],
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

const tee: ProductSnapshot = {
  id: 'prod_tee',
  slug: 'tee',
  name: 'Tee',
  description: 'A tee',
  shortDescription: 'Tee',
  status: 'active',
  type: 'variable',
  seoTitle: 'Tee | Store',
  seoDescription: 'Buy a tee',
  media: [],
  metadata: {},
  categoryIds: [],
  variants: [
    variantOf(),
    variantOf({
      id: 'var_small',
      name: 'Small',
      sku: 'TEE-S',
      priceMinor: 2000,
      weightGrams: null,
    }),
  ],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
}

const reads: PreviewReads = {
  currency: 'GBP',
  product: async (key) => (key === tee.id ? tee : null),
  variant: async () => null,
  order: async () => null,
}

function viewOf(args: Record<string, unknown>): ProposalView {
  return {
    id: 'prop_1',
    tool: 'tool',
    title: 'title',
    command: 'product.update',
    args: { id: tee.id, ...args },
    handles: [],
    idempotencyKey: null,
    status: 'pending',
    proposer: { userId: null, agent: { name: 'agent' } },
    correlationId: 'corr',
    createdAt: '2026-11-01T00:00:00.000Z',
  }
}

const rows = async (args: Record<string, unknown>): Promise<ProposalChange[]> =>
  (await previewOf(viewOf(args), reads))?.changes ?? []

const isWeight = (c: ProposalChange) => / \(g\)$/.test(c.label) && c.label.startsWith('Weight of ')

describe('previewOf: product.update of variant weights', () => {
  const [large, small] = tee.variants as [Variant, Variant]

  // Kills: a weight the update would store, approved from a preview that lists prices only.
  it('AC-4: an entry holding weightGrams previews Weight of <name> (g), the stored grams beside the proposed ones (none for null), after that variant’s price rows; the same entries without the key list no weight row and are otherwise the same', async () => {
    const variants = [
      { id: large.id, priceMinor: large.priceMinor, compareAtPriceMinor: 2800, weightGrams: null },
      { id: small.id, priceMinor: 1800, weightGrams: 750 },
    ]
    const withWeight = await rows({ variants })
    const withoutWeight = await rows({
      variants: variants.map(({ weightGrams: _weightGrams, ...rest }) => rest),
    })

    expect(withWeight.map((c) => c.label)).toEqual([
      `Price of ${large.name}`,
      `Compare-at price of ${large.name}`,
      `Weight of ${large.name} (g)`,
      `Price of ${small.name}`,
      `Weight of ${small.name} (g)`,
    ])
    expect(withWeight.filter(isWeight)).toEqual([
      {
        label: `Weight of ${large.name} (g)`,
        kind: 'value',
        current: large.weightGrams,
        proposed: null,
      },
      { label: `Weight of ${small.name} (g)`, kind: 'value', current: null, proposed: 750 },
    ])
    expect(withoutWeight).toEqual(withWeight.filter((c) => !isWeight(c)))
  })

  // Kills: a weight row placed among another variant's rows, or before its own variant's prices, when the entry also
  // carries a GTIN.
  it('AC-4: beside a GTIN, a variant’s weight row comes after its own price rows and before the next variant’s first row', async () => {
    const changes = await rows({
      variants: [
        { id: large.id, priceMinor: large.priceMinor, gtin: '4006381333931', weightGrams: 0 },
        { id: small.id, priceMinor: small.priceMinor, gtin: null },
      ],
    })
    const labels = changes.map((c) => c.label)
    const weightAt = labels.indexOf(`Weight of ${large.name} (g)`)

    expect(changes[weightAt]).toEqual({
      label: `Weight of ${large.name} (g)`,
      kind: 'value',
      current: large.weightGrams,
      proposed: 0,
    })
    expect(weightAt, labels.join(' | ')).toBeGreaterThan(labels.indexOf(`Price of ${large.name}`))
    expect(weightAt, labels.join(' | ')).toBeLessThan(labels.indexOf(`Price of ${small.name}`))
    expect(changes.filter(isWeight).length, 'weight rows').toBe(1)
  })
})
