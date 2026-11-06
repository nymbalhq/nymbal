import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  NotFoundError,
  type Order,
  type ProductSnapshot,
  type ProposalView,
  type Variant,
} from '@nymbalhq/types'
import { previewOf, storePreviewReads, type PreviewReads } from './proposal-preview.js'

// An admin approves an agent's write from its card: what it acts on, and each value as it is now beside what the write
// would make it. A wrong current value, a wrong sum or a missing target is an approval of something the admin never saw.

function variantOf(over: Partial<Variant> = {}): Variant {
  return {
    id: 'var_large',
    productId: 'prod_tee',
    sku: 'TEE-L',
    name: 'Large',
    priceMinor: 2500,
    compareAtPriceMinor: 3000,
    weightGrams: null,
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

function productOf(over: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    id: 'prod_tee',
    slug: 'tee',
    name: 'Tee',
    description: 'A tee',
    shortDescription: 'Tee',
    status: 'active',
    type: 'variable',
    seoTitle: 'Tee | Store',
    seoDescription: 'Buy a tee',
    media: [{ url: 'https://cdn.example/a.jpg', altText: 'front', position: 0 }],
    metadata: { fabric: 'cotton', fit: 'regular' },
    categoryIds: ['cat_tops', 'cat_new'],
    variants: [
      variantOf(),
      variantOf({ id: 'var_small', name: 'Small', sku: 'TEE-S', priceMinor: 2000 }),
    ],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

function orderOf(over: Partial<Order> = {}): Order {
  return {
    id: 'ord_1',
    orderNumber: '1001',
    status: 'processing',
    currency: 'EUR',
    refundedMinor: 500,
    ...over,
  } as Order
}

function viewOf(
  command: string,
  args: Record<string, unknown>,
  over: Partial<ProposalView> = {},
): ProposalView {
  return {
    id: 'prop_1',
    tool: 'tool',
    title: 'title',
    command,
    args,
    handles: [],
    idempotencyKey: null,
    status: 'pending',
    proposer: { userId: null, agent: { name: 'agent' } },
    correlationId: 'corr',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

/** Reads over fixed records, each found by exactly the id it is keyed by. */
function readsOf(
  records: {
    products?: Record<string, ProductSnapshot>
    variants?: Record<string, { variant: Variant; productName: string }>
    orders?: Record<string, Order>
  } = {},
  currency = 'GBP',
): PreviewReads {
  return {
    currency,
    product: async (key) => records.products?.[key] ?? null,
    variant: async (key) => records.variants?.[key] ?? null,
    order: async (key) => records.orders?.[key] ?? null,
  }
}

const tee = productOf()
const productReads = readsOf({ products: { [tee.id]: tee } })

describe('previewOf: which proposals carry a preview', () => {
  it('a pending proposal of each previewed command is previewed; the same proposal once decided, or another command, is not', async () => {
    const reads = readsOf({
      products: { [tee.id]: tee },
      variants: { var_large: { variant: variantOf(), productName: 'Tee' } },
      orders: { ord_1: orderOf() },
    })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['product.update', { id: tee.id, name: 'New' }],
      ['inventory.adjust', { variantId: 'var_large', delta: 1 }],
      ['order.refund', { id: 'ord_1', amountMinor: 100 }],
      ['order.cancel', { id: 'ord_1' }],
    ]
    for (const [command, args] of cases) {
      const pending = await previewOf(viewOf(command, args), reads)
      expect(pending?.changes.length, command).toBe(1)
      for (const status of ['approved', 'rejected', 'applied', 'failed'] as const) {
        expect(
          await previewOf(viewOf(command, args, { status }), reads),
          `${command} ${status}`,
        ).toBeUndefined()
      }
    }
    expect(
      await previewOf(viewOf('product.create', { id: tee.id, name: 'New' }), reads),
    ).toBeUndefined()
  })
})

describe('previewOf: product.update', () => {
  it('names the product it reads and lists only the fields the write sends, each beside its value now, in the form order', async () => {
    const preview = await previewOf(
      viewOf('product.update', {
        seoTitle: 'Tee!',
        id: tee.id,
        name: 'Tee v2',
        status: 'archived',
      }),
      productReads,
    )
    expect(preview).toEqual({
      target: { kind: 'product', id: tee.id, label: tee.name },
      changes: [
        { label: 'Name', kind: 'value', current: tee.name, proposed: 'Tee v2' },
        { label: 'Status', kind: 'value', current: tee.status, proposed: 'archived' },
        { label: 'SEO title', kind: 'value', current: tee.seoTitle, proposed: 'Tee!' },
      ],
      currency: 'GBP',
    })
  })

  it('every scalar field sent is listed with its current value; a value that is neither text nor a number reads as none', async () => {
    const args = {
      id: tee.id,
      name: 'n',
      description: 'd',
      shortDescription: 's',
      status: 'draft',
      type: 'simple',
      seoTitle: 't',
      seoDescription: { not: 'text' },
    }
    const preview = await previewOf(viewOf('product.update', args), productReads)
    expect(preview?.changes.map((c) => [c.label, c.current, c.proposed])).toEqual([
      ['Name', tee.name, 'n'],
      ['Description', tee.description, 'd'],
      ['Short description', tee.shortDescription, 's'],
      ['Status', tee.status, 'draft'],
      ['Type', tee.type, 'simple'],
      ['SEO title', tee.seoTitle, 't'],
      ['SEO description', tee.seoDescription, null],
    ])
  })

  it('a price change shows each named variant’s price now beside the new one, and its compare-at price only when sent', async () => {
    const [large, small] = tee.variants
    const preview = await previewOf(
      viewOf('product.update', {
        id: tee.id,
        variants: [
          { id: large!.id, priceMinor: large!.priceMinor - 500, compareAtPriceMinor: null },
          { id: small!.id, priceMinor: { amount: 1 } },
          'not a variant',
        ],
      }),
      productReads,
    )
    expect(preview?.changes).toEqual([
      {
        label: `Price of ${large!.name}`,
        kind: 'money',
        current: large!.priceMinor,
        proposed: large!.priceMinor - 500,
      },
      {
        label: `Compare-at price of ${large!.name}`,
        kind: 'money',
        current: large!.compareAtPriceMinor,
        proposed: null,
      },
      {
        label: `Price of ${small!.name}`,
        kind: 'money',
        current: small!.priceMinor,
        proposed: null,
      },
    ])
  })

  it('a variant the product does not have is listed by its id with no current price', async () => {
    const preview = await previewOf(
      viewOf('product.update', {
        id: tee.id,
        variants: [{ id: 'var_gone', priceMinor: 999, compareAtPriceMinor: 1 }],
      }),
      productReads,
    )
    expect(preview?.changes).toEqual([
      { label: 'Variant var_gone', kind: 'money', current: null, proposed: 999 },
    ])
  })

  it('a variants field that is not a list changes no price', async () => {
    const preview = await previewOf(
      viewOf('product.update', {
        id: tee.id,
        variants: { id: tee.variants[0]!.id, priceMinor: 1 },
      }),
      productReads,
    )
    expect(preview?.changes).toEqual([])
    expect(preview?.target?.id).toBe(tee.id)
  })

  // After the variant tests: a fault that reads a string as a record recurses without end in the collections' compare,
  // so a test that fails on it without comparing collections has to run first.
  it('collections read as counts, changed only when their contents differ, whatever the key order', async () => {
    const preview = await previewOf(
      viewOf('product.update', {
        id: tee.id,
        categoryIds: [...tee.categoryIds, 'cat_sale'],
        metadata: { fit: 'regular', fabric: 'cotton' },
        media: [...tee.media],
      }),
      productReads,
    )
    expect(preview?.changes).toEqual([
      {
        label: 'Media',
        kind: 'collection',
        current: tee.media.length,
        proposed: tee.media.length,
        changed: false,
      },
      { label: 'Metadata', kind: 'collection', current: 2, proposed: 2, changed: false },
      {
        label: 'Categories',
        kind: 'collection',
        current: tee.categoryIds.length,
        proposed: tee.categoryIds.length + 1,
        changed: true,
      },
    ])
  })

  it('a collection of the same size with other contents is changed; one cleared to nothing counts zero', async () => {
    const preview = await previewOf(
      viewOf('product.update', {
        id: tee.id,
        metadata: { fabric: 'linen', fit: 'regular' },
        media: null,
      }),
      productReads,
    )
    const [media, metadata] = preview!.changes
    expect(media).toEqual({
      label: 'Media',
      kind: 'collection',
      current: 1,
      proposed: 0,
      changed: true,
    })
    expect(metadata!.proposed).toBe(metadata!.current)
    expect(metadata!.changed).toBe(true)
  })

  it('a product that does not exist answers no target and no changes, in the store currency', async () => {
    for (const args of [{ id: 'prod_gone', name: 'x' }, { name: 'x' }]) {
      expect(await previewOf(viewOf('product.update', args), productReads)).toEqual({
        target: null,
        changes: [],
        currency: 'GBP',
      })
    }
  })
})

describe('previewOf: inventory.adjust', () => {
  const large = variantOf()
  const reads = readsOf({ variants: { [large.id]: { variant: large, productName: 'Tee' } } }, 'USD')

  it('names the variant with its product and SKU, and the stock after is the stock now plus the delta', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -1000, max: 1000 }), async (delta) => {
        const preview = await previewOf(
          viewOf('inventory.adjust', { variantId: large.id, delta }),
          reads,
        )
        expect(preview?.target).toEqual({
          kind: 'variant',
          id: large.id,
          label: 'Tee, Large (TEE-L)',
        })
        const [stock] = preview!.changes
        expect(stock).toMatchObject({ label: 'Stock', kind: 'value', current: large.stock })
        expect(Number(stock!.proposed) - Number(stock!.current)).toBe(delta)
        expect(preview?.currency).toBe('USD')
      }),
    )
  })

  it('a delta that is not a number leaves the stock as it is', async () => {
    const preview = await previewOf(
      viewOf('inventory.adjust', { variantId: large.id, delta: '5' }),
      reads,
    )
    expect(preview?.changes[0]?.proposed).toBe(preview?.changes[0]?.current)
  })

  it('a variant that does not exist answers no target and no changes', async () => {
    expect(
      await previewOf(viewOf('inventory.adjust', { variantId: 'var_gone', delta: 1 }), reads),
    ).toEqual({
      target: null,
      changes: [],
      currency: 'USD',
    })
  })
})

describe('previewOf: order.refund and order.cancel', () => {
  const order = orderOf({ currency: 'EUR', refundedMinor: 500, status: 'processing' })
  const reads = readsOf({ orders: { [order.id]: order } }, 'GBP')

  it('a refund shows what is refunded now and after, in the order’s currency, not the store’s', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (amountMinor) => {
        const preview = await previewOf(
          viewOf('order.refund', { id: order.id, amountMinor }),
          reads,
        )
        expect(preview?.target).toEqual({
          kind: 'order',
          id: order.id,
          label: `#${order.orderNumber}`,
        })
        const [refunded] = preview!.changes
        expect(refunded).toMatchObject({
          label: 'Refunded',
          kind: 'money',
          current: order.refundedMinor,
        })
        expect(Number(refunded!.proposed) - Number(refunded!.current)).toBe(amountMinor)
        expect(preview?.currency).toBe(order.currency)
      }),
    )
  })

  it('a refund with no amount adds nothing to what is refunded', async () => {
    const preview = await previewOf(viewOf('order.refund', { id: order.id }), reads)
    expect(preview?.changes[0]?.proposed).toBe(order.refundedMinor)
  })

  it('a cancel shows the order’s status now beside cancelled', async () => {
    const preview = await previewOf(
      viewOf('order.cancel', { id: order.id, amountMinor: 100 }),
      reads,
    )
    expect(preview).toEqual({
      target: { kind: 'order', id: order.id, label: '#1001' },
      changes: [{ label: 'Status', kind: 'value', current: 'processing', proposed: 'cancelled' }],
      currency: 'EUR',
    })
  })

  it('an order that does not exist answers no target and no changes, in the store currency', async () => {
    for (const command of ['order.refund', 'order.cancel']) {
      expect(await previewOf(viewOf(command, { id: 'ord_gone', amountMinor: 1 }), reads)).toEqual({
        target: null,
        changes: [],
        currency: 'GBP',
      })
    }
  })
})

describe('storePreviewReads', () => {
  const TX = { tx: true }
  const store = { read: <T>(fn: (tx: unknown) => Promise<T>) => fn(TX) }
  const small = variantOf({ id: 'var_small', name: 'Small', productId: 'prod_tee' })
  const orphan = variantOf({ id: 'var_orphan', productId: 'prod_deleted' })
  const order = orderOf({ id: 'ord_9', orderNumber: '1009' })

  function readsWith(failure?: Error): PreviewReads {
    const found = (hit: boolean, key: string): Promise<ProductSnapshot> =>
      hit ? Promise.resolve(tee) : Promise.reject(failure ?? new NotFoundError('product', key))
    return storePreviewReads({
      currency: 'JPY',
      product: {
        getById: (id: string) => found(id === tee.id, id),
        getBySlug: (slug: string) => found(slug === tee.slug, slug),
      } as never,
      repos: {
        product: {
          findById: async (tx: unknown, id: string) => (tx === TX && id === tee.id ? tee : null),
        },
        variant: {
          store,
          findById: async (tx: unknown, id: string) =>
            tx !== TX ? null : ([small, orphan].find((v) => v.id === id) ?? null),
        },
        order: {
          store,
          findById: async (tx: unknown, id: string) =>
            tx === TX && id === order.id ? order : null,
          findByOrderNumber: async (tx: unknown, n: string) =>
            tx === TX && n === order.orderNumber ? order : null,
        },
      } as never,
    })
  }

  it('reads a product by id, else by slug, and none for a key that is neither', async () => {
    const reads = readsWith()
    expect(reads.currency).toBe('JPY')
    expect((await reads.product(tee.id))?.id).toBe(tee.id)
    expect((await reads.product(tee.slug))?.id).toBe(tee.id)
    expect(await reads.product('nope')).toBeNull()
  })

  it('a failure other than not-found is not read as a missing product', async () => {
    await expect(readsWith(new Error('database down')).product('nope')).rejects.toThrow(
      'database down',
    )
  })

  it('reads a variant with its product’s name, a blank name when the product is gone, and none for an unknown id', async () => {
    const reads = readsWith()
    expect(await reads.variant(small.id)).toEqual({ variant: small, productName: tee.name })
    expect(await reads.variant(orphan.id)).toEqual({ variant: orphan, productName: '' })
    expect(await reads.variant('var_gone')).toBeNull()
  })

  it('reads an order by id, else by number, and none for a key that is neither', async () => {
    const reads = readsWith()
    expect((await reads.order(order.id))?.id).toBe(order.id)
    expect((await reads.order(order.orderNumber))?.id).toBe(order.id)
    expect(await reads.order('ord_gone')).toBeNull()
  })
})
