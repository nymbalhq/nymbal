import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mapProduct, productWarnings } from '../../src/woocommerce/mappers/product.js'
import type { WcVariation } from '../../src/woocommerce/client.js'
import { storeContext, wcProduct, wcVariable, wcVariation } from './support/wc.js'

// WooCommerce counts stock per product, per variation (`manage_stock: true`), or once for a variable product whose
// variations say `manage_stock: 'parent'` (each such variation reports the parent's quantity). An untracked item
// (`manage_stock: false`) has only a `stock_status`. Nymbal always counts stock, per variant.

const stockStatus = fc.constantFrom('instock', 'outofstock', 'onbackorder')
const store = fc.record({
  lowStockAmount: fc.integer({ min: 0, max: 20 }),
  untrackedStock: fc.integer({ min: 0, max: 5000 }),
})

/** What AC-3 imports for an item WooCommerce counts or leaves untracked. */
function ownStock(
  item: { manage_stock: boolean | 'parent'; stock_quantity: number | null; stock_status: string },
  untrackedStock: number,
): number {
  if (item.manage_stock === true) return Math.max(0, item.stock_quantity ?? 0)
  return item.stock_status === 'outofstock' ? 0 : untrackedStock
}

describe('mapProduct stock, simple products', () => {
  it('AC-3: property: counted stock imports as max(0, quantity), untracked stock as untrackedStock unless out of stock, the low-stock threshold is the product’s or else the store’s, and only owed backorders or untracked stock in stock are warned about', () => {
    fc.assert(
      fc.property(
        store,
        fc.boolean(),
        fc.integer({ min: -50, max: 500 }),
        stockStatus,
        fc.option(fc.integer({ min: 0, max: 50 }), { nil: null }),
        (ctx, managed, quantity, status, lowStock) => {
          const wc = wcProduct({
            manage_stock: managed,
            stock_quantity: managed ? quantity : null,
            stock_status: status,
            backorders: managed && quantity < 0 ? 'notify' : 'no',
            low_stock_amount: lowStock,
          })
          const variant = mapProduct(wc, [], [], [], '', storeContext(ctx)).variants![0]!
          expect(variant.stock).toBe(ownStock(wc, ctx.untrackedStock))
          expect(variant.stock).toBeGreaterThanOrEqual(0)
          expect(variant.lowStockThreshold).toBe(lowStock ?? ctx.lowStockAmount)
          // With no sale, only owed backorders and untracked stock imported as in stock are lossy: a count carried
          // over exactly, 0 included, gets no warning.
          const lossy =
            (managed && quantity < 0 ? 1 : 0) +
            (!managed && ownStock(wc, ctx.untrackedStock) > 0 ? 1 : 0)
          expect(productWarnings(wc, [], storeContext(ctx))).toHaveLength(lossy)
        },
      ),
      { numRuns: 400 },
    )
  })

  it('AC-3: a negative quantity imports as 0 with one warning (backorders owed)', () => {
    const wc = wcProduct({
      manage_stock: true,
      stock_quantity: -3,
      stock_status: 'onbackorder',
      backorders: 'notify',
    })
    const ctx = storeContext()
    expect(mapProduct(wc, [], [], [], '', ctx).variants![0]!.stock).toBe(0)
    expect(productWarnings(wc, [], ctx)).toHaveLength(1)
  })

  it('AC-3: an untracked product in stock imports at untrackedStock with one warning naming that count', () => {
    const wc = wcProduct({ manage_stock: false, stock_quantity: null, stock_status: 'instock' })
    const ctx = storeContext({ untrackedStock: 250 })
    expect(mapProduct(wc, [], [], [], '', ctx).variants![0]!.stock).toBe(250)
    const warnings = productWarnings(wc, [], ctx)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('250')
  })
})

/** A variable product's variations as WooCommerce answers them, with distinct ids in no particular order. */
const variableProduct = fc
  .record({
    parentManaged: fc.boolean(),
    parentQuantity: fc.integer({ min: -20, max: 300 }),
    variations: fc.array(
      fc.record({
        manage: fc.constantFrom<boolean | 'parent'>(true, false, 'parent'),
        quantity: fc.integer({ min: -20, max: 200 }),
        status: stockStatus,
        private: fc.boolean(),
        lowStock: fc.option(fc.integer({ min: 0, max: 50 }), { nil: null }),
      }),
      { minLength: 1, maxLength: 6 },
    ),
    ids: fc.uniqueArray(fc.integer({ min: 100, max: 999 }), { minLength: 6, maxLength: 6 }),
  })
  .map(({ parentManaged, parentQuantity, variations, ids }) => {
    // 'parent' is what a variation answers only when its parent counts stock, and a shared pool always has a
    // published variation to sell from.
    const drafts = variations.map((v) => ({
      ...v,
      manage: v.manage === 'parent' && !parentManaged ? true : v.manage,
    }))
    const firstShared = drafts.findIndex((v) => v.manage === 'parent')
    if (firstShared >= 0) drafts[firstShared]!.private = false
    const wcVariations: WcVariation[] = drafts.map((v, i) =>
      wcVariation({
        id: ids[i]!,
        sku: `V-${ids[i]}`,
        status: v.private ? 'private' : 'publish',
        attributes: [{ id: 1, name: 'Size', option: `S${ids[i]}` }],
        manage_stock: v.manage,
        stock_quantity: v.manage === 'parent' ? parentQuantity : v.manage ? v.quantity : null,
        stock_status: v.status,
        low_stock_amount: v.manage === true ? v.lowStock : null,
      }),
    )
    return {
      parent: wcVariable(wcVariations, {
        manage_stock: parentManaged,
        stock_quantity: parentManaged ? parentQuantity : null,
        low_stock_amount: null,
      }),
      variations: wcVariations,
    }
  })

describe('mapProduct stock, variable products', () => {
  it('AC-3: property: a shared parent pool splits evenly over its published variations, the remainder to the lowest ids, and managed stock sums to the stock pools’ sum, each pool once, with a warning only for what is not carried over exactly', () => {
    fc.assert(
      fc.property(store, variableProduct, (ctx, { parent, variations }) => {
        const product = mapProduct(parent, variations, [], [], '', storeContext(ctx))
        const stock = new Map(product.variants!.map((v) => [v.sku, v.stock]))
        const threshold = new Map(product.variants!.map((v) => [v.sku, v.lowStockThreshold]))

        const pool = Math.max(0, parent.stock_quantity ?? 0)
        const sharers = variations
          .filter((v) => v.manage_stock === 'parent' && v.status === 'publish')
          .sort((a, b) => a.id - b.id)
        sharers.forEach((v, rank) => {
          const share = Math.floor(pool / sharers.length) + (rank < pool % sharers.length ? 1 : 0)
          expect(stock.get(v.sku), `${v.sku}, rank ${rank} of ${sharers.length} over ${pool}`).toBe(
            share,
          )
        })
        for (const v of variations.filter((v) => v.manage_stock !== 'parent')) {
          expect(stock.get(v.sku), v.sku).toBe(ownStock(v, ctx.untrackedStock))
        }
        for (const v of variations.filter((v) => v.manage_stock === true)) {
          expect(threshold.get(v.sku), v.sku).toBe(v.low_stock_amount ?? ctx.lowStockAmount)
        }

        const managed = variations.filter((v) => v.manage_stock !== false)
        const imported = managed.reduce((sum, v) => sum + stock.get(v.sku)!, 0)
        const pools =
          variations
            .filter((v) => v.manage_stock === true)
            .reduce((sum, v) => sum + Math.max(0, v.stock_quantity ?? 0), 0) +
          (variations.some((v) => v.manage_stock === 'parent') ? pool : 0)
        expect(imported).toBe(pools)
        for (const v of product.variants!) expect(v.stock, v.sku).toBeGreaterThanOrEqual(0)

        // One warning per variation owing backorders, one for a shared pool and one for untracked variations
        // imported as in stock: an untracked variation out of stock is carried over exactly.
        const owed = variations.filter(
          (v) => v.manage_stock === true && (v.stock_quantity ?? 0) < 0,
        ).length
        const untracked = variations.some(
          (v) => v.manage_stock === false && ownStock(v, ctx.untrackedStock) > 0,
        )
        expect(productWarnings(parent, variations, storeContext(ctx))).toHaveLength(
          owed + (sharers.length > 0 ? 1 : 0) + (untracked ? 1 : 0),
        )
      }),
      { numRuns: 400 },
    )
  })

  it('AC-3: a pool of 10 shared by three variations imports as 4, 3, 3 by ascending id, with one warning for the product', () => {
    const variations = [205, 201, 203].map((id) =>
      wcVariation({
        id,
        sku: `V-${id}`,
        attributes: [{ id: 1, name: 'Size', option: `S${id}` }],
        manage_stock: 'parent',
        stock_quantity: 10,
      }),
    )
    const parent = wcVariable(variations, { manage_stock: true, stock_quantity: 10 })
    const ctx = storeContext()
    const stock = new Map(
      mapProduct(parent, variations, [], [], '', ctx).variants!.map((v) => [v.sku, v.stock]),
    )
    expect([stock.get('V-201'), stock.get('V-203'), stock.get('V-205')]).toEqual([4, 3, 3])
    expect(productWarnings(parent, variations, ctx)).toHaveLength(1)
  })

  it('AC-3: two untracked variations of one product give one warning, naming the count', () => {
    const variations = [301, 302].map((id) =>
      wcVariation({
        id,
        sku: `V-${id}`,
        attributes: [{ id: 1, name: 'Size', option: `S${id}` }],
        manage_stock: false,
        stock_quantity: null,
        stock_status: 'instock',
      }),
    )
    const parent = wcVariable(variations)
    const ctx = storeContext({ untrackedStock: 640 })
    const stock = mapProduct(parent, variations, [], [], '', ctx).variants!.map((v) => v.stock)
    expect(stock).toEqual([640, 640])
    const warnings = productWarnings(parent, variations, ctx)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('640')
  })
})
