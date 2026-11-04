import { readFile, writeFile } from 'node:fs/promises'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadState, type ImportEntity } from '@nymbalhq/importers'
import type { Order } from '@nymbalhq/types'
import { importStore, openStoreApp, type StoreApp } from './support/store-app.js'
import { arbStore, clashFree, type Rec, type WooStore } from './support/woo-store.js'
import { CURRENCIES, sourceFigures } from './support/wc-orders.js'

// What an imported order's lines and money say, through the whole import on a store built from the platform's dist
// through createApp (`pnpm build` first): the variant each line bought, and totals that add up as WooCommerce's did.

afterEach(() => {
  vi.unstubAllGlobals()
})

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)

describe('AC-9: an order line points at the variant that was bought', () => {
  const ORDER_ID = 5001

  function product(id: number, over: Rec): Rec {
    return {
      id,
      name: `product ${id}`,
      slug: `product-${id}`,
      type: 'simple',
      status: 'publish',
      description: '',
      short_description: '',
      sku: `SKU-${id}`,
      regular_price: '25.00',
      sale_price: '',
      categories: [],
      images: [],
      attributes: [],
      variations: [],
      meta_data: [],
      downloadable: false,
      virtual: false,
      weight: '1',
      dimensions: { length: '20', width: '15', height: '5' },
      ...over,
    }
  }

  function variation(id: number, sku: string, size: string): Rec {
    return {
      id,
      sku,
      regular_price: '40.00',
      sale_price: '',
      stock_quantity: 5,
      status: 'publish',
      attributes: [{ id: 1, name: 'Size', option: size }],
      weight: '0.5',
      dimensions: { length: '10', width: '10', height: '2' },
    }
  }

  function line(id: number, productId: number, variationId: number): Rec {
    return {
      id,
      name: `line ${id}`,
      product_id: productId,
      variation_id: variationId,
      quantity: 1,
      price: 40,
      subtotal: '40.00',
      subtotal_tax: '0.00',
      total: '40.00',
      total_tax: '0.00',
      sku: '',
      meta_data: [],
    }
  }

  /** A hoodie in two sizes (variations 1001 and 1002) and a mug; one order of the medium hoodie, the mug, a product the
   * source no longer lists, and a hoodie variation the hoodie does not list. */
  const source: WooStore = {
    categories: [],
    products: [
      product(10, { type: 'variable', sku: 'HOOD', variations: [1001, 1002] }),
      product(20, { sku: 'MUG-1' }),
    ],
    variations: { 10: [variation(1001, 'HOOD-S', 'S'), variation(1002, 'HOOD-M', 'M')] },
    customers: [],
    orders: [
      {
        id: ORDER_ID,
        number: String(ORDER_ID),
        status: 'completed',
        currency: 'GBP',
        date_created: '2024-02-01T12:00:00',
        customer_id: 0,
        billing: {
          first_name: 'Ann',
          last_name: 'Buyer',
          company: '',
          address_1: '1 Lane',
          address_2: '',
          city: 'York',
          state: 'yorkshire',
          postcode: 'YO1 1AA',
          country: 'GB',
          phone: '',
          email: 'ann@example.com',
        },
        shipping: {
          first_name: 'Ann',
          last_name: 'Buyer',
          company: '',
          address_1: '1 Lane',
          address_2: '',
          city: 'York',
          state: 'yorkshire',
          postcode: 'YO1 1AA',
          country: 'GB',
          phone: '',
        },
        line_items: [line(1, 10, 1002), line(2, 20, 0), line(3, 999, 0), line(4, 10, 9999)],
        shipping_lines: [],
        tax_lines: [],
        discount_total: '0.00',
        shipping_total: '0.00',
        total_tax: '0.00',
        total: '160.00',
        customer_note: '',
        meta_data: [],
        payment_method: 'stripe',
      },
    ],
    reviews: [],
  }

  /** Each line's product and variant ids, and those the store holds for the hoodie's medium and the mug. */
  async function linesAndExpected(env: StoreApp) {
    const state = (await loadState(env.statePath))!
    const hoodie = await env.app.services.product.getById(state.wcToNymbalProduct['10']!)
    const mug = await env.app.services.product.getById(state.wcToNymbalProduct['20']!)
    const orderId = state.wcToNymbalOrder[String(ORDER_ID)]
    const lines =
      orderId === undefined
        ? 'the order was not imported'
        : (await env.app.services.order.getById(orderId)).lineItems.map((l) => [
            l.productId,
            l.variantId,
          ])
    const medium = hoodie.variants.find((v) => v.sku === 'HOOD-M')!
    return {
      lines,
      expected: [
        [hoodie.id, medium.id],
        [mug.id, mug.variants[0]!.id],
        ['unknown', 'unknown'],
        [hoodie.id, 'unknown'],
      ],
    }
  }

  it("AC-9: imported in one run, a variation line carries its product and the variant made from that variation, a simple product's line its one variant, a product not imported 'unknown' for both, and an unlisted variation the product with variant 'unknown'", async () => {
    const env = await openStoreApp()
    try {
      await importStore(env, { store: source, entities: ['products', 'orders'] })
      const { lines, expected } = await linesAndExpected(env)

      expect(lines).toEqual(expected)
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-9: the same holds when products and orders are imported in separate runs (--entities products, then --entities orders)', async () => {
    const env = await openStoreApp()
    try {
      await importStore(env, { store: source, entities: ['products'] })
      await importStore(env, { store: source, entities: ['orders'] })
      const { lines, expected } = await linesAndExpected(env)

      expect(lines).toEqual(expected)
    } finally {
      await env.close()
    }
  }, 120_000)

  it("an order whose product was deleted in the store between the products run and the orders run still imports, that product's lines with variant 'unknown'", async () => {
    const env = await openStoreApp()
    try {
      await importStore(env, { store: source, entities: ['products'] })
      const before = (await loadState(env.statePath))!
      const hoodieId = before.wcToNymbalProduct['10']!
      const mug = await env.app.services.product.getById(before.wcToNymbalProduct['20']!)
      await env.app.services.product.delete(hoodieId)

      const report = await importStore(env, { store: source, entities: ['orders'] })
      const orderId = (await loadState(env.statePath))!.wcToNymbalOrder[String(ORDER_ID)]
      const lines =
        orderId === undefined
          ? 'the order was not imported'
          : (await env.app.services.order.getById(orderId)).lineItems.map((l) => [
              l.productId,
              l.variantId,
            ])

      expect({ errors: report.errors, lines }).toEqual({
        errors: [],
        lines: [
          [hoodieId, 'unknown'],
          [mug.id, mug.variants[0]!.id],
          ['unknown', 'unknown'],
          [hoodieId, 'unknown'],
        ],
      })
    } finally {
      await env.close()
    }
  }, 120_000)

  it('a done state saved before entities were marked finished counts only the entities it has a cursor for as finished, so a later orders run imports the orders', async () => {
    const env = await openStoreApp()
    try {
      await importStore(env, { store: source, entities: ['products'] })
      const saved = JSON.parse(await readFile(env.statePath, 'utf8')) as Record<string, unknown>
      delete saved['finished']
      await writeFile(env.statePath, JSON.stringify({ ...saved, phase: 'done' }), 'utf8')

      const loaded = (await loadState(env.statePath))!
      await importStore(env, { store: source, entities: ['orders'] })
      const { lines, expected } = await linesAndExpected(env)

      expect({ finished: loaded.finished, lines }).toEqual({
        finished: ['products'],
        lines: expected,
      })
    } finally {
      await env.close()
    }
  }, 120_000)
})

describe('AC-10: imported orders add up as WooCommerce charged them', () => {
  const ENTITIES: ImportEntity[] = ['categories', 'products', 'customers', 'orders']

  it("AC-10: for generated stores of orders that add up in one currency (GBP, USD, JPY or KWD), the imported orders' totals sum to the source totals, and each order's subtotal − discount + shipping + tax = total, its subtotal is the sum of its lines and its line tax plus shipping tax is its tax total", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...CURRENCIES).chain((currency) =>
          arbStore({
            products: fc.integer({ min: 1, max: 4 }),
            categories: 2,
            customers: 3,
            orders: 6,
            reviews: 0,
            currency,
          }).map((store) => ({ currency, store: clashFree(store) })),
        ),
        fc.integer({ min: 1, max: 4 }),
        async ({ currency, store }, concurrency) => {
          const env = await openStoreApp()
          try {
            await importStore(env, { store, entities: ENTITIES, concurrency })
            const state = (await loadState(env.statePath))!
            const pairs: Array<{ source: Rec; order: Order | undefined }> = []
            for (const source of store.orders) {
              const id = state.wcToNymbalOrder[String(source['id'])]
              pairs.push({
                source,
                order: id === undefined ? undefined : await env.app.services.order.getById(id),
              })
            }
            const imported = pairs.flatMap((p) =>
              p.order === undefined ? [] : [{ source: p.source, order: p.order }],
            )

            expect(imported.length).toBe(store.orders.length)
            expect(sum(imported.map((p) => p.order.totalMinor))).toBe(
              sum(store.orders.map((o) => sourceFigures(o, currency).total)),
            )
            expect(
              imported.map(({ order }) => ({
                identity:
                  order.subtotalMinor -
                  order.discountTotalMinor +
                  order.shippingTotalMinor +
                  order.taxTotalMinor,
                subtotal: order.subtotalMinor,
                tax: order.taxTotalMinor,
              })),
            ).toEqual(
              imported.map(({ source, order }) => ({
                identity: order.totalMinor,
                subtotal: sum(order.lineItems.map((l) => l.lineSubtotalMinor)),
                tax:
                  sum(order.lineItems.map((l) => l.lineTaxMinor)) +
                  sourceFigures(source, currency).shippingTax,
              })),
            )
          } finally {
            await env.close()
          }
        },
      ),
      { numRuns: 12 },
    )
  }, 600_000)
})
