import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWooCommerceImport } from '@nymbalhq/importers'
import { buildImportEnv } from './support/import-env.js'
import {
  RECORDED_STORES,
  importedProducts,
  loadRecordedStore,
  localMedia,
  minorUnits,
  recordedFetch,
  recordedImportOptions,
  type Rec,
  type RecordedStore,
} from './support/recorded-store.js'

// Each recorded WooCommerce store imported whole through the fetch mock, and the catalogue that lands compared with
// what WooCommerce said, read here from the payloads: counts, the sum of the prices charged, the compare-at sums and
// the stock. A variant counts as sold when it and its product are active. Needs `pnpm build`.

const UNTRACKED_STOCK = 1000

interface SourceVariant {
  sku: string
  price: string
  sold: boolean
  priceMinor: number | null
  compareAtMinor: number | null
  /** Counted by WooCommerce, on its own or in its parent's pool. */
  counted: boolean
  stock: number
}

/** What WooCommerce was selling, and how: one entry per variant the import should create. */
function sourceVariants(store: RecordedStore): SourceVariant[] {
  const minor = (price: unknown) => minorUnits(String(price ?? ''), store.currency)
  const untracked = (item: Rec) => (item['stock_status'] === 'outofstock' ? 0 : UNTRACKED_STOCK)
  const out: SourceVariant[] = []
  for (const p of store.products) {
    const published = p['status'] === 'publish'
    if (p['type'] === 'variable') {
      const variations = store.variations[p['id'] as number] ?? []
      const productSold = published && variations.some((v) => v['price'] !== '')
      const pool = Math.max(0, (p['stock_quantity'] as number | null) ?? 0)
      const sharers = variations
        .filter((v) => v['manage_stock'] === 'parent' && v['status'] === 'publish')
        .sort((a, b) => (a['id'] as number) - (b['id'] as number))
      for (const v of variations) {
        const rank = sharers.indexOf(v)
        const stock =
          v['manage_stock'] === true
            ? Math.max(0, v['stock_quantity'] as number)
            : v['manage_stock'] === 'parent'
              ? rank < 0
                ? 0
                : Math.floor(pool / sharers.length) + (rank < pool % sharers.length ? 1 : 0)
              : untracked(v)
        out.push({
          sku: v['sku'] as string,
          price: v['price'] as string,
          sold: productSold && v['status'] === 'publish' && v['price'] !== '',
          priceMinor: minor(v['price']),
          compareAtMinor:
            v['on_sale'] === true && minor(v['regular_price'])! > minor(v['price'])!
              ? minor(v['regular_price'])
              : null,
          counted: v['manage_stock'] !== false,
          stock,
        })
      }
      continue
    }
    const sellableType = p['type'] === 'simple'
    out.push({
      sku: p['sku'] as string,
      price: p['price'] as string,
      sold: published && sellableType && p['price'] !== '',
      priceMinor: minor(p['price']),
      compareAtMinor:
        p['on_sale'] === true &&
        minor(p['regular_price']) !== null &&
        minor(p['regular_price'])! > minor(p['price'])!
          ? minor(p['regular_price'])
          : null,
      counted: p['manage_stock'] === true,
      stock: p['manage_stock'] === true ? Math.max(0, p['stock_quantity'] as number) : untracked(p),
    })
  }
  return out
}

/** WooCommerce's stock pools, each counted once: a counted product, a counted variation, a parent pool its variations share. */
function poolSum(store: RecordedStore): number {
  let sum = 0
  for (const p of store.products) {
    const quantity = Math.max(0, (p['stock_quantity'] as number | null) ?? 0)
    if (p['type'] !== 'variable') {
      if (p['manage_stock'] === true) sum += quantity
      continue
    }
    const variations = store.variations[p['id'] as number] ?? []
    for (const v of variations) {
      if (v['manage_stock'] === true) sum += Math.max(0, v['stock_quantity'] as number)
    }
    if (variations.some((v) => v['manage_stock'] === 'parent')) sum += quantity
  }
  return sum
}

const sum = (values: Iterable<number | null>) =>
  [...values].reduce<number>((a, b) => a + (b ?? 0), 0)

let dir: string | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('importing the recorded WooCommerce stores', () => {
  for (const name of RECORDED_STORES) {
    it(`AC-10: ${name}: every product arrives or is refused, prices charged, compare-at and stock sum to what WooCommerce said, nothing goes live at 0 that WooCommerce did not price at 0, and no errors`, async () => {
      const store = loadRecordedStore(name)
      dir = await mkdtemp(join(tmpdir(), `nymbal-recorded-${name}-`))
      const env = await buildImportEnv()
      try {
        vi.stubGlobal('fetch', recordedFetch(store).fetch)
        const opts = recordedImportOptions(store, dir)
        const report = await runWooCommerceImport(opts, {
          services: env.services,
          repos: env.repos,
          adapters: env.adapters,
          media: localMedia(dir),
        })
        const products = await importedProducts(env, opts.statePath)
        const variants = [...products.values()].flatMap((p) =>
          p.variants.map((v) => ({ ...v, productActive: p.status === 'active' })),
        )
        const source = sourceVariants(store)
        const bySku = new Map(source.map((s) => [s.sku, s]))

        // Counts.
        const refused = report.errors.filter((e) => e.phase === 'products').length
        expect(report.imported.products + refused).toBe(store.totals['products.page-1.json'])
        expect(store.products.length).toBe(store.totals['products.page-1.json'])
        const variationsRead = [...products.keys()].reduce(
          (n, wcId) => n + (store.variations[wcId]?.length ?? 0),
          0,
        )
        const nonVariable = store.products.filter((p) => p['type'] !== 'variable').length
        expect(variants.length).toBe(nonVariable + variationsRead)
        expect(report.errors).toEqual([])

        // Nothing is sold at 0 unless WooCommerce charged 0.
        const freeByMistake = variants
          .filter(
            (v) => v.status === 'active' && v.priceMinor === 0 && bySku.get(v.sku)?.price !== '0',
          )
          .map((v) => v.sku)
        expect(freeByMistake).toEqual([])

        // What is sold, at what price and compare-at.
        const sold = variants.filter((v) => v.productActive && v.status === 'active')
        const expectedSold = source.filter((s) => s.sold)
        expect(Object.fromEntries(sold.map((v) => [v.sku, v.priceMinor]))).toEqual(
          Object.fromEntries(expectedSold.map((s) => [s.sku, s.priceMinor])),
        )
        expect(sum(sold.map((v) => v.priceMinor))).toBe(sum(expectedSold.map((s) => s.priceMinor)))
        expect(Object.fromEntries(sold.map((v) => [v.sku, v.compareAtPriceMinor]))).toEqual(
          Object.fromEntries(expectedSold.map((s) => [s.sku, s.compareAtMinor])),
        )
        expect(sum(sold.map((v) => v.compareAtPriceMinor))).toBe(
          sum(expectedSold.map((s) => s.compareAtMinor)),
        )

        // Stock: each variant sold has AC-3's stock, and counted stock sums to the pools, each pool once.
        expect(Object.fromEntries(sold.map((v) => [v.sku, v.stock]))).toEqual(
          Object.fromEntries(expectedSold.map((s) => [s.sku, s.stock])),
        )
        const counted = variants.filter((v) => bySku.get(v.sku)?.counted === true)
        expect(sum(counted.map((v) => v.stock))).toBe(poolSum(store))

        // The store's own images are fetched from its home_url, not skipped.
        for (const [wcId, product] of products) {
          const wc = store.products.find((p) => p['id'] === wcId)!
          const sources = new Set((wc['images'] as Array<{ src: string }>).map((i) => i.src))
          expect(product.media.length, `product ${wcId} images`).toBe(sources.size)
        }
      } finally {
        await env.close()
      }
    })
  }
})
